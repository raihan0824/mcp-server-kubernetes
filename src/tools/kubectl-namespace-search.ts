import { KubernetesManager } from "../types.js";
import { execSync } from "child_process";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export const kubectlNamespaceSearchSchema = {
    name: "kubectl_namespace_search",
    description: "Search and filter namespaces with pattern matching, common filters, and smart suggestions for large clusters",
    inputSchema: {
        type: "object",
        properties: {
            pattern: {
                type: "string",
                description: "Search pattern to match namespace names (supports wildcards like 'app-*', '*-prod', or regex patterns)",
                optional: true
            },
            excludeSystem: {
                type: "boolean",
                description: "Exclude system namespaces (kube-*, default, etc.)",
                default: true
            },
            status: {
                type: "string",
                enum: ["Active", "Terminating", "all"],
                description: "Filter by namespace status",
                default: "Active"
            },
            limit: {
                type: "number",
                description: "Limit the number of results returned",
                default: 20
            },
            labelSelector: {
                type: "string",
                description: "Filter namespaces by label selector (e.g. 'environment=production')",
                optional: true
            },
            showLabels: {
                type: "boolean",
                description: "Show namespace labels in output",
                default: false
            },
            sortBy: {
                type: "string",
                enum: ["name", "age", "status"],
                description: "Sort results by field",
                default: "name"
            },
            output: {
                type: "string",
                enum: ["table", "json", "names"],
                description: "Output format",
                default: "table"
            }
        },
        required: [],
    },
} as const;

export async function kubectlNamespaceSearch(
    k8sManager: KubernetesManager,
    input: {
        pattern?: string;
        excludeSystem?: boolean;
        status?: string;
        limit?: number;
        labelSelector?: string;
        showLabels?: boolean;
        sortBy?: string;
        output?: string;
    }
) {
    try {
        const {
            pattern,
            excludeSystem = true,
            status = "Active",
            limit = 20,
            labelSelector,
            showLabels = false,
            sortBy = "name",
            output = "table"
        } = input;

        // Build the kubectl command
        let command = "kubectl get namespaces";

        // Add label selector if provided
        if (labelSelector) {
            command += ` -l ${labelSelector}`;
        }

        // Add status filter if not 'all'
        if (status !== "all") {
            command += ` --field-selector=status.phase=${status}`;
        }

        // Get output format
        if (output === "json") {
            command += " -o json";
        } else if (output === "names") {
            command += " -o name";
        } else {
            // For table output, use custom columns
            const columns = showLabels
                ? "NAME:.metadata.name,STATUS:.status.phase,AGE:.metadata.creationTimestamp,LABELS:.metadata.labels"
                : "NAME:.metadata.name,STATUS:.status.phase,AGE:.metadata.creationTimestamp";
            command += ` -o custom-columns="${columns}"`;
        }

        // Execute the command
        const result = execSync(command, { encoding: "utf8" });

        let namespaces: any[] = [];

        if (output === "json") {
            const jsonResult = JSON.parse(result);
            namespaces = jsonResult.items || [];
        } else if (output === "names") {
            namespaces = result.trim().split('\n')
                .filter(line => line.trim())
                .map(line => ({ name: line.replace('namespace/', '') }));
        } else {
            // Parse table output
            const lines = result.trim().split('\n');
            const headers = lines[0];
            namespaces = lines.slice(1).map(line => {
                const parts = line.split(/\s+/);
                return {
                    name: parts[0],
                    status: parts[1],
                    age: parts[2],
                    labels: showLabels ? parts[3] : undefined
                };
            });
        }

        // Apply filters
        let filteredNamespaces = namespaces;

        // System namespace filter
        if (excludeSystem) {
            const systemNamespaces = [
                'kube-system', 'kube-public', 'kube-node-lease', 'default',
                'kubernetes-dashboard', 'ingress-nginx', 'cert-manager',
                'monitoring', 'logging', 'istio-system', 'linkerd'
            ];

            filteredNamespaces = filteredNamespaces.filter(ns => {
                const name = ns.name || ns.metadata?.name;
                return !systemNamespaces.includes(name) &&
                    !name.startsWith('kube-') &&
                    !name.startsWith('openshift-');
            });
        }

        // Pattern matching
        if (pattern) {
            const regex = new RegExp(
                pattern
                    .replace(/\*/g, '.*')  // Convert wildcards to regex
                    .replace(/\?/g, '.')   // Convert single char wildcards
                    .replace(/\./g, '\\.')  // Escape dots
                    .replace(/\.\*/g, '.*'), // Restore wildcards
                'i'
            );

            filteredNamespaces = filteredNamespaces.filter(ns => {
                const name = ns.name || ns.metadata?.name;
                return regex.test(name);
            });
        }

        // Sort results
        filteredNamespaces.sort((a, b) => {
            const nameA = a.name || a.metadata?.name;
            const nameB = b.name || b.metadata?.name;

            switch (sortBy) {
                case "age":
                    const ageA = a.age || a.metadata?.creationTimestamp;
                    const ageB = b.age || b.metadata?.creationTimestamp;
                    return new Date(ageA).getTime() - new Date(ageB).getTime();
                case "status":
                    const statusA = a.status || a.status?.phase;
                    const statusB = b.status || b.status?.phase;
                    return statusA.localeCompare(statusB);
                default:
                    return nameA.localeCompare(nameB);
            }
        });

        // Apply limit
        if (limit > 0) {
            filteredNamespaces = filteredNamespaces.slice(0, limit);
        }

        // Format output
        let outputText = "";
        const totalFound = filteredNamespaces.length;

        if (output === "json") {
            outputText = JSON.stringify({
                total: totalFound,
                namespaces: filteredNamespaces
            }, null, 2);
        } else if (output === "names") {
            outputText = filteredNamespaces
                .map(ns => ns.name || ns.metadata?.name)
                .join('\n');
        } else {
            // Table format
            outputText = `Found ${totalFound} namespace(s):\n\n`;

            if (showLabels) {
                outputText += "NAME                    STATUS    AGE       LABELS\n";
                outputText += "----                    ------    ---       ------\n";
                filteredNamespaces.forEach(ns => {
                    const name = (ns.name || ns.metadata?.name).padEnd(20);
                    const status = (ns.status || ns.status?.phase || 'Unknown').padEnd(8);
                    const age = (ns.age || 'Unknown').padEnd(8);
                    const labels = ns.labels || 'none';
                    outputText += `${name} ${status} ${age} ${labels}\n`;
                });
            } else {
                outputText += "NAME                    STATUS    AGE\n";
                outputText += "----                    ------    ---\n";
                filteredNamespaces.forEach(ns => {
                    const name = (ns.name || ns.metadata?.name).padEnd(20);
                    const status = (ns.status || ns.status?.phase || 'Unknown').padEnd(8);
                    const age = ns.age || 'Unknown';
                    outputText += `${name} ${status} ${age}\n`;
                });
            }
        }

        return {
            content: [
                {
                    type: "text",
                    text: outputText,
                },
            ],
        };

    } catch (error: any) {
        throw new McpError(
            ErrorCode.InternalError,
            `Failed to search namespaces: ${error.message}`
        );
    }
} 