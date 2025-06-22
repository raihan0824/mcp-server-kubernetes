import { KubernetesManager } from "../types.js";
import { execSync } from "child_process";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export const kubectlClusterOverviewSchema = {
    name: "kubectl_cluster_overview",
    description: "Get a high-level overview of cluster resources with counts and status summaries, perfect for large clusters",
    inputSchema: {
        type: "object",
        properties: {
            includeSystemNamespaces: {
                type: "boolean",
                description: "Include system namespaces in the overview",
                default: false
            },
            namespacePattern: {
                type: "string",
                description: "Pattern to match namespace names (supports wildcards like 'app-*')",
                optional: true
            },
            resourceTypes: {
                type: "array",
                items: { type: "string" },
                description: "Specific resource types to include (default: common resources)",
                optional: true
            },
            showTop: {
                type: "number",
                description: "Show top N namespaces by resource count",
                default: 10
            },
            showDetails: {
                type: "boolean",
                description: "Show detailed breakdown per namespace",
                default: false
            }
        },
        required: [],
    },
} as const;

export async function kubectlClusterOverview(
    k8sManager: KubernetesManager,
    input: {
        includeSystemNamespaces?: boolean;
        namespacePattern?: string;
        resourceTypes?: string[];
        showTop?: number;
        showDetails?: boolean;
    }
) {
    try {
        const {
            includeSystemNamespaces = false,
            namespacePattern,
            resourceTypes = ['pods', 'deployments', 'services', 'configmaps', 'secrets'],
            showTop = 10,
            showDetails = false
        } = input;

        // Get all namespaces
        const allNamespaces = await getFilteredNamespaces(namespacePattern, includeSystemNamespaces);

        // Collect resource counts
        const overview: any = {
            totalNamespaces: allNamespaces.length,
            resourceCounts: {},
            namespaceBreakdown: new Map<string, any>()
        };

        // Initialize resource counts
        resourceTypes.forEach(type => {
            overview.resourceCounts[type] = 0;
        });

        // Collect data for each namespace
        for (const namespace of allNamespaces) {
            const nsData: any = {
                name: namespace,
                resources: {}
            };

            for (const resourceType of resourceTypes) {
                try {
                    const count = await getResourceCount(resourceType, namespace);
                    overview.resourceCounts[resourceType] += count;
                    nsData.resources[resourceType] = count;
                } catch (error) {
                    nsData.resources[resourceType] = 0;
                }
            }

            // Calculate total resources in this namespace
            nsData.total = Object.values(nsData.resources).reduce((sum: number, count: any) => sum + count, 0);
            overview.namespaceBreakdown.set(namespace, nsData);
        }

        // Get cluster-level info
        const clusterInfo = await getClusterInfo();

        // Format output
        return formatOverview(overview, clusterInfo, showTop, showDetails);

    } catch (error: any) {
        throw new McpError(
            ErrorCode.InternalError,
            `Cluster overview failed: ${error.message}`
        );
    }
}

async function getFilteredNamespaces(
    namespacePattern?: string,
    includeSystemNamespaces: boolean = false
): Promise<string[]> {
    try {
        const command = "kubectl get namespaces -o name";
        const result = execSync(command, { encoding: "utf8" });

        let namespaces = result.trim()
            .split('\n')
            .map(line => line.replace('namespace/', ''))
            .filter(ns => ns.trim());

        // Filter system namespaces
        if (!includeSystemNamespaces) {
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

        return namespaces;
    } catch (error) {
        throw new Error(`Failed to get namespaces: ${error}`);
    }
}

async function getResourceCount(resourceType: string, namespace: string): Promise<number> {
    try {
        const command = `kubectl get ${resourceType} -n ${namespace} --no-headers 2>/dev/null | wc -l`;
        const result = execSync(command, { encoding: "utf8", shell: "/bin/bash" });
        return parseInt(result.trim()) || 0;
    } catch (error) {
        return 0;
    }
}

async function getClusterInfo(): Promise<any> {
    try {
        const nodeInfo = execSync("kubectl get nodes --no-headers | wc -l", {
            encoding: "utf8",
            shell: "/bin/bash"
        });

        const versionInfo = execSync("kubectl version --short --client 2>/dev/null || echo 'Unknown'", {
            encoding: "utf8",
            shell: "/bin/bash"
        });

        return {
            totalNodes: parseInt(nodeInfo.trim()) || 0,
            version: versionInfo.trim()
        };
    } catch (error) {
        return {
            totalNodes: 0,
            version: 'Unknown'
        };
    }
}

function formatOverview(
    overview: any,
    clusterInfo: any,
    showTop: number,
    showDetails: boolean
): { content: Array<{ type: string; text: string }> } {
    let output = "🏗️  KUBERNETES CLUSTER OVERVIEW\n";
    output += "═".repeat(50) + "\n\n";

    // Cluster summary
    output += "📊 CLUSTER SUMMARY:\n";
    output += `  • Total Nodes: ${clusterInfo.totalNodes}\n`;
    output += `  • Total Namespaces: ${overview.totalNamespaces}\n`;
    output += `  • Kubectl Version: ${clusterInfo.version}\n\n`;

    // Resource counts
    output += "📦 RESOURCE TOTALS:\n";
    Object.entries(overview.resourceCounts).forEach(([type, count]) => {
        const icon = getResourceIcon(type);
        output += `  ${icon} ${type.padEnd(15)}: ${count}\n`;
    });
    output += "\n";

    // Top namespaces by resource count
    const sortedNamespaces = Array.from(overview.namespaceBreakdown.values())
        .sort((a: any, b: any) => b.total - a.total)
        .slice(0, showTop);

    output += `🔝 TOP ${showTop} NAMESPACES BY RESOURCE COUNT:\n`;
    output += "─".repeat(40) + "\n";

    sortedNamespaces.forEach((ns: any, index: number) => {
        const rank = (index + 1).toString().padStart(2);
        output += `${rank}. ${ns.name.padEnd(25)} (${ns.total} resources)\n`;

        if (showDetails) {
            Object.entries(ns.resources).forEach(([type, count]: [string, any]) => {
                if (count > 0) {
                    const icon = getResourceIcon(type);
                    output += `    ${icon} ${type}: ${count}\n`;
                }
            });
            output += "\n";
        }
    });

    // Usage suggestions
    output += "\n💡 USAGE SUGGESTIONS:\n";
    output += "─".repeat(40) + "\n";
    output += "• Use 'kubectl_namespace_search' to find specific namespaces\n";
    output += "• Use 'kubectl_smart_search' to find resources across namespaces\n";
    output += "• Use 'kubectl_list' with 'limit' parameter for large result sets\n";
    output += "• Use label selectors to filter resources efficiently\n";

    return {
        content: [
            {
                type: "text",
                text: output,
            },
        ],
    };
}

function getResourceIcon(resourceType: string): string {
    const icons: Record<string, string> = {
        'pods': '🚀',
        'deployments': '📦',
        'services': '🌐',
        'configmaps': '⚙️',
        'secrets': '🔐',
        'ingresses': '🚪',
        'persistentvolumes': '💾',
        'persistentvolumeclaims': '📀',
        'nodes': '🖥️',
        'namespaces': '📁'
    };
    return icons[resourceType] || '📋';
} 