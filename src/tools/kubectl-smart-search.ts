import { KubernetesManager } from "../types.js";
import { execSync } from "child_process";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export const kubectlSmartSearchSchema = {
    name: "kubectl_smart_search",
    description: "Smart search for Kubernetes resources across namespaces with intelligent filtering, pagination, and suggestions for large clusters",
    inputSchema: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "Search query - can be resource name pattern, label selector, or field selector"
            },
            resourceType: {
                type: "string",
                description: "Type of resource to search (pods, deployments, services, etc.) - if not specified, searches common resources",
                optional: true
            },
            namespacePattern: {
                type: "string",
                description: "Pattern to match namespace names (supports wildcards like 'app-*')",
                optional: true
            },
            excludeSystemNamespaces: {
                type: "boolean",
                description: "Exclude system namespaces from search",
                default: true
            },
            searchMode: {
                type: "string",
                enum: ["name", "labels", "fields", "smart"],
                description: "Search mode: name (resource names), labels (label selectors), fields (field selectors), or smart (auto-detect)",
                default: "smart"
            },
            limit: {
                type: "number",
                description: "Maximum number of results to return",
                default: 50
            },
            output: {
                type: "string",
                enum: ["summary", "detailed", "json"],
                description: "Output format",
                default: "summary"
            },
            showNamespaces: {
                type: "boolean",
                description: "Group results by namespace",
                default: true
            },
            recent: {
                type: "boolean",
                description: "Only show resources created in the last 24 hours",
                default: false
            }
        },
        required: ["query"],
    },
} as const;

export async function kubectlSmartSearch(
    k8sManager: KubernetesManager,
    input: {
        query: string;
        resourceType?: string;
        namespacePattern?: string;
        excludeSystemNamespaces?: boolean;
        searchMode?: string;
        limit?: number;
        output?: string;
        showNamespaces?: boolean;
        recent?: boolean;
    }
) {
    try {
        const {
            query,
            resourceType,
            namespacePattern,
            excludeSystemNamespaces = true,
            searchMode = "smart",
            limit = 50,
            output = "summary",
            showNamespaces = true,
            recent = false
        } = input;

        // Get target namespaces
        const namespaces = await getTargetNamespaces(namespacePattern, excludeSystemNamespaces);

        // Determine resource types to search
        const resourceTypes = resourceType ? [resourceType] : [
            'pods', 'deployments', 'services', 'configmaps', 'secrets', 'ingresses'
        ];

        // Determine search strategy based on mode and query
        const searchStrategy = determineSearchStrategy(query, searchMode);

        const results: any[] = [];
        let totalFound = 0;

        // Search each resource type in target namespaces
        for (const resType of resourceTypes) {
            for (const namespace of namespaces) {
                if (totalFound >= limit) break;

                try {
                    const resources = await searchResourcesInNamespace(
                        resType,
                        namespace,
                        query,
                        searchStrategy,
                        recent,
                        limit - totalFound
                    );

                    if (resources.length > 0) {
                        results.push({
                            resourceType: resType,
                            namespace: namespace,
                            resources: resources
                        });
                        totalFound += resources.length;
                    }
                } catch (error) {
                    // Continue searching other namespaces/resources even if one fails
                    console.error(`Error searching ${resType} in ${namespace}:`, error);
                }
            }
            if (totalFound >= limit) break;
        }

        // Format output
        return formatSearchResults(results, output, showNamespaces, totalFound, limit);

    } catch (error: any) {
        throw new McpError(
            ErrorCode.InternalError,
            `Smart search failed: ${error.message}`
        );
    }
}

async function getTargetNamespaces(
    namespacePattern?: string,
    excludeSystemNamespaces: boolean = true
): Promise<string[]> {
    try {
        const command = "kubectl get namespaces -o name";
        const result = execSync(command, { encoding: "utf8" });

        let namespaces = result.trim()
            .split('\n')
            .map(line => line.replace('namespace/', ''))
            .filter(ns => ns.trim());

        // Filter system namespaces
        if (excludeSystemNamespaces) {
            const systemNamespaces = [
                'kube-system', 'kube-public', 'kube-node-lease', 'default',
                'kubernetes-dashboard', 'ingress-nginx', 'cert-manager',
                'monitoring', 'logging', 'istio-system', 'linkerd'
            ];

            namespaces = namespaces.filter(ns =>
                !systemNamespaces.includes(ns) &&
                !ns.startsWith('kube-') &&
                !ns.startsWith('openshift-')
            );
        }

        // Apply namespace pattern if provided
        if (namespacePattern) {
            const regex = new RegExp(
                namespacePattern
                    .replace(/\*/g, '.*')
                    .replace(/\?/g, '.')
                    .replace(/\./g, '\\.')
                    .replace(/\.\*/g, '.*'),
                'i'
            );
            namespaces = namespaces.filter(ns => regex.test(ns));
        }

        return namespaces.slice(0, 20); // Limit to 20 namespaces to avoid overwhelming searches
    } catch (error) {
        throw new Error(`Failed to get namespaces: ${error}`);
    }
}

function determineSearchStrategy(query: string, searchMode: string): {
    type: 'name' | 'labels' | 'fields';
    selector: string;
} {
    if (searchMode !== 'smart') {
        return { type: searchMode as any, selector: query };
    }

    // Smart detection logic
    if (query.includes('=')) {
        // Looks like a label or field selector
        if (query.includes('metadata.') || query.includes('status.') || query.includes('spec.')) {
            return { type: 'fields', selector: query };
        } else {
            return { type: 'labels', selector: query };
        }
    } else {
        // Treat as name pattern
        return { type: 'name', selector: query };
    }
}

async function searchResourcesInNamespace(
    resourceType: string,
    namespace: string,
    query: string,
    strategy: { type: 'name' | 'labels' | 'fields'; selector: string },
    recent: boolean,
    maxResults: number
): Promise<any[]> {
    let command = `kubectl get ${resourceType} -n ${namespace}`;

    // Add selectors based on strategy
    if (strategy.type === 'labels') {
        command += ` -l ${strategy.selector}`;
    } else if (strategy.type === 'fields') {
        command += ` --field-selector=${strategy.selector}`;
    }

    // Add recent filter if requested
    if (recent) {
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const timestamp = yesterday.toISOString();

        if (strategy.type === 'fields') {
            command += `,metadata.creationTimestamp>=${timestamp}`;
        } else {
            command += ` --field-selector=metadata.creationTimestamp>=${timestamp}`;
        }
    }

    command += " -o json";

    try {
        const result = execSync(command, { encoding: "utf8" });
        const jsonResult = JSON.parse(result);
        let resources = jsonResult.items || [];

        // Apply name filtering if needed
        if (strategy.type === 'name') {
            const regex = new RegExp(
                strategy.selector
                    .replace(/\*/g, '.*')
                    .replace(/\?/g, '.')
                    .replace(/\./g, '\\.')
                    .replace(/\.\*/g, '.*'),
                'i'
            );
            resources = resources.filter((resource: any) =>
                regex.test(resource.metadata.name)
            );
        }

        return resources.slice(0, maxResults);
    } catch (error: any) {
        if (error.status === 1 && error.stderr.includes('No resources found')) {
            return [];
        }
        throw error;
    }
}

function formatSearchResults(
    results: any[],
    output: string,
    showNamespaces: boolean,
    totalFound: number,
    limit: number
): { content: Array<{ type: string; text: string }> } {
    if (output === "json") {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        totalFound,
                        limit,
                        results
                    }, null, 2),
                },
            ],
        };
    }

    let outputText = `Found ${totalFound} resource(s)`;
    if (totalFound >= limit) {
        outputText += ` (limited to ${limit})`;
    }
    outputText += ":\n\n";

    if (output === "summary") {
        // Group by namespace if requested
        if (showNamespaces) {
            const byNamespace = new Map<string, any[]>();

            results.forEach(result => {
                if (!byNamespace.has(result.namespace)) {
                    byNamespace.set(result.namespace, []);
                }
                byNamespace.get(result.namespace)!.push(result);
            });

            byNamespace.forEach((nsResults, namespace) => {
                outputText += `📁 Namespace: ${namespace}\n`;
                outputText += "─".repeat(40) + "\n";

                nsResults.forEach(result => {
                    outputText += `  ${result.resourceType.toUpperCase()}:\n`;
                    result.resources.forEach((resource: any) => {
                        const age = getResourceAge(resource.metadata.creationTimestamp);
                        const status = getResourceStatus(resource);
                        outputText += `    • ${resource.metadata.name} (${status}, ${age})\n`;
                    });
                });
                outputText += "\n";
            });
        } else {
            // Group by resource type
            const byResourceType = new Map<string, any[]>();

            results.forEach(result => {
                if (!byResourceType.has(result.resourceType)) {
                    byResourceType.set(result.resourceType, []);
                }
                result.resources.forEach((resource: any) => {
                    byResourceType.get(result.resourceType)!.push({
                        ...resource,
                        namespace: result.namespace
                    });
                });
            });

            byResourceType.forEach((resources, resourceType) => {
                outputText += `📦 ${resourceType.toUpperCase()}:\n`;
                outputText += "─".repeat(40) + "\n";

                resources.forEach((resource: any) => {
                    const age = getResourceAge(resource.metadata.creationTimestamp);
                    const status = getResourceStatus(resource);
                    outputText += `  • ${resource.metadata.name} (ns: ${resource.namespace}, ${status}, ${age})\n`;
                });
                outputText += "\n";
            });
        }
    } else if (output === "detailed") {
        results.forEach(result => {
            outputText += `\n${result.resourceType.toUpperCase()} in ${result.namespace}:\n`;
            outputText += "═".repeat(50) + "\n";

            result.resources.forEach((resource: any) => {
                outputText += `Name: ${resource.metadata.name}\n`;
                outputText += `Namespace: ${resource.metadata.namespace}\n`;
                outputText += `Age: ${getResourceAge(resource.metadata.creationTimestamp)}\n`;
                outputText += `Status: ${getResourceStatus(resource)}\n`;

                if (resource.metadata.labels) {
                    outputText += `Labels: ${Object.entries(resource.metadata.labels)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(', ')}\n`;
                }

                outputText += "─".repeat(30) + "\n";
            });
        });
    }

    return {
        content: [
            {
                type: "text",
                text: outputText,
            },
        ],
    };
}

function getResourceAge(creationTimestamp: string): string {
    const created = new Date(creationTimestamp);
    const now = new Date();
    const diffMs = now.getTime() - created.getTime();

    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (diffDays > 0) return `${diffDays}d`;
    if (diffHours > 0) return `${diffHours}h`;
    return `${diffMinutes}m`;
}

function getResourceStatus(resource: any): string {
    if (resource.status?.phase) return resource.status.phase;
    if (resource.status?.conditions) {
        const readyCondition = resource.status.conditions.find((c: any) => c.type === 'Ready');
        if (readyCondition) return readyCondition.status === 'True' ? 'Ready' : 'NotReady';
    }
    if (resource.spec?.replicas !== undefined && resource.status?.readyReplicas !== undefined) {
        return `${resource.status.readyReplicas}/${resource.spec.replicas}`;
    }
    return 'Unknown';
} 