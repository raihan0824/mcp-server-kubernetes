import { KubernetesManager } from "../types.js";
import { exec, execSync } from "child_process";
import { promisify } from "util";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const execAsync = promisify(exec);

export const kubectlUnifiedSearchSchema = {
    name: "kubectl_search",
    description: "Unified search for Kubernetes resources with fuzzy matching, smart filtering, and comprehensive namespace support. Handles typos, partial matches, and various search patterns.",
    inputSchema: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "Search query - resource name, partial name, typos, label selector, or field selector"
            },
            resourceTypes: {
                type: "array",
                items: {
                    type: "string",
                    enum: ["pods", "deployments", "services", "replicasets", "statefulsets", "daemonsets", "jobs", "cronjobs", "configmaps", "secrets", "ingresses", "namespaces"]
                },
                description: "Types of resources to search (default: pods, deployments, services)",
                default: ["pods", "deployments", "services"]
            },
            namespaces: {
                type: "array",
                items: { type: "string" },
                description: "Specific namespaces to search in (if not provided, searches all namespaces)",
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
                default: false
            },
            searchMode: {
                type: "string",
                enum: ["auto", "fuzzy", "exact", "labels", "fields"],
                description: "Search mode: auto (smart detection), fuzzy (typo-tolerant), exact (precise matching), labels (label selectors), fields (field selectors)",
                default: "auto"
            },
            fuzzyTolerance: {
                type: "string",
                enum: ["strict", "moderate", "loose"],
                description: "Fuzzy matching tolerance: strict (exact + small typos), moderate (balanced), loose (very tolerant)",
                default: "moderate"
            },
            limit: {
                type: "number",
                description: "Maximum number of results to return",
                default: 20
            },
            includeLabels: {
                type: "boolean",
                description: "Include label matching in search",
                default: true
            },
            includeAnnotations: {
                type: "boolean",
                description: "Include annotation matching in search",
                default: false
            },
            sortBy: {
                type: "string",
                enum: ["relevance", "name", "age", "namespace"],
                description: "Sort results by relevance score, name, age, or namespace",
                default: "relevance"
            },
            output: {
                type: "string",
                enum: ["detailed", "summary", "json"],
                description: "Output format",
                default: "detailed"
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

interface SearchResult {
    resource: any;
    resourceType: string;
    namespace: string;
    matchScore: number;
    matchReason: string;
    levenshteinDistance: number;
}

interface SearchConfig {
    maxDistance: number;
    minScore: number;
}

export async function kubectlUnifiedSearch(
    k8sManager: KubernetesManager,
    input: {
        query: string;
        resourceTypes?: string[];
        namespaces?: string[];
        namespacePattern?: string;
        excludeSystemNamespaces?: boolean;
        searchMode?: string;
        fuzzyTolerance?: string;
        limit?: number;
        includeLabels?: boolean;
        includeAnnotations?: boolean;
        sortBy?: string;
        output?: string;
        recent?: boolean;
    }
) {
    // Early validation
    if (!input.query || input.query.trim().length === 0) {
        throw new Error("Search query cannot be empty");
    }

    const {
        query,
        resourceTypes = ["pods", "deployments", "services"],
        namespaces,
        namespacePattern,
        excludeSystemNamespaces = false,
        searchMode = "auto",
        fuzzyTolerance = "moderate",
        limit = 20,
        includeLabels = true,
        includeAnnotations = false,
        sortBy = "relevance",
        output = "detailed",
        recent = false
    } = input;

    try {
        // Get all target namespaces - no limit needed with batching approach
        const targetNamespaces = await getTargetNamespaces(
            namespaces,
            namespacePattern,
            excludeSystemNamespaces,
            query,
            undefined // No limit - process all namespaces in batches
        );

        if (targetNamespaces.length === 0) {
            return formatSearchResults([], output, query, "No namespaces to search");
        }

        // Determine search strategy
        const strategy = determineSearchStrategy(query, searchMode);
        const searchConfig = getFuzzyConfig(fuzzyTolerance);

        // Use streaming search for better performance
        const results = await streamingSearch(
            resourceTypes,
            targetNamespaces,
            query,
            strategy,
            searchConfig,
            includeLabels,
            includeAnnotations,
            recent,
            limit
        );

        // Sort results
        const sortedResults = sortResults(results, sortBy);

        return formatSearchResults(sortedResults, output, query, strategy.type);

    } catch (error: any) {
        throw new Error(`Search failed: ${error.message}`);
    }
}

function determineSearchStrategy(query: string, searchMode: string): {
    type: 'fuzzy' | 'exact' | 'labels' | 'fields';
    selector: string;
} {
    if (searchMode !== 'auto') {
        return { type: searchMode as any, selector: query };
    }

    // Auto-detection logic
    if (query.includes('=')) {
        // Looks like a label or field selector
        if (query.includes('metadata.') || query.includes('status.') || query.includes('spec.')) {
            return { type: 'fields', selector: query };
        } else {
            return { type: 'labels', selector: query };
        }
    } else if (query.includes('*') || query.includes('?')) {
        // Wildcard pattern - use exact matching with regex
        return { type: 'exact', selector: query };
    } else {
        // Default to fuzzy matching for natural language queries
        return { type: 'fuzzy', selector: query };
    }
}

function getFuzzyConfig(tolerance: string): SearchConfig {
    switch (tolerance) {
        case "strict":
            return { maxDistance: 1, minScore: 0.8 };
        case "loose":
            return { maxDistance: 4, minScore: 0.2 };
        case "moderate":
        default:
            return { maxDistance: 2, minScore: 0.4 };
    }
}

async function getTargetNamespaces(
    namespaces?: string[],
    namespacePattern?: string,
    excludeSystemNamespaces: boolean = false,
    query?: string,
    maxNamespaces?: number // Optional limit - undefined means no limit
): Promise<string[]> {
    if (namespaces && namespaces.length > 0) {
        return maxNamespaces ? namespaces.slice(0, maxNamespaces) : namespaces;
    }

    try {
        const command = "kubectl get namespaces -o name";
        const { stdout } = await execAsync(command, {
            timeout: 5000,
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large outputs
        });

        let allNamespaces = stdout.trim()
            .split('\n')
            .map(line => line.replace('namespace/', ''))
            .filter(ns => ns.trim());

        // Filter system namespaces if requested
        if (excludeSystemNamespaces) {
            const systemNamespaces = [
                'kube-system', 'kube-public', 'kube-node-lease', 'default',
                'kubernetes-dashboard', 'ingress-nginx', 'cert-manager',
                'monitoring', 'logging', 'istio-system', 'linkerd'
            ];

            allNamespaces = allNamespaces.filter(ns =>
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
            allNamespaces = allNamespaces.filter(ns => regex.test(ns));
        }

        // Apply limit only if specified
        return maxNamespaces ? allNamespaces.slice(0, maxNamespaces) : allNamespaces;
    } catch (error) {
        throw new Error(`Failed to get namespaces: ${error}`);
    }
}

async function searchNamespaces(
    query: string,
    namespaces: string[],
    strategy: { type: string; selector: string },
    searchConfig: SearchConfig
): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const queryLower = query.toLowerCase();

    for (const namespace of namespaces) {
        const namespaceLower = namespace.toLowerCase();
        const matches = [];

        if (strategy.type === 'fuzzy') {
            // Exact substring match
            if (namespaceLower.includes(queryLower)) {
                matches.push({
                    score: 1.0,
                    reason: "exact substring match",
                    distance: 0
                });
            }

            // Fuzzy match
            const distance = levenshteinDistance(queryLower, namespaceLower);
            if (distance <= searchConfig.maxDistance) {
                const score = 1 - (distance / Math.max(queryLower.length, namespaceLower.length));
                if (score >= searchConfig.minScore) {
                    matches.push({
                        score: score,
                        reason: `fuzzy match (distance: ${distance})`,
                        distance: distance
                    });
                }
            }
        } else if (strategy.type === 'exact') {
            const regex = new RegExp(
                strategy.selector
                    .replace(/\*/g, '.*')
                    .replace(/\?/g, '.')
                    .replace(/\./g, '\\.')
                    .replace(/\.\*/g, '.*'),
                'i'
            );
            if (regex.test(namespace)) {
                matches.push({
                    score: 1.0,
                    reason: "pattern match",
                    distance: 0
                });
            }
        }

        if (matches.length > 0) {
            const bestMatch = matches.reduce((best, current) =>
                current.score > best.score ? current : best
            );

            results.push({
                resource: { metadata: { name: namespace, creationTimestamp: new Date().toISOString() } },
                resourceType: "namespace",
                namespace: namespace,
                matchScore: bestMatch.score,
                matchReason: bestMatch.reason,
                levenshteinDistance: bestMatch.distance
            });
        }
    }

    return results;
}

async function getResourcesFromNamespace(
    resourceType: string,
    namespace: string,
    recent: boolean
): Promise<any[]> {
    try {
        let command = `kubectl get ${resourceType} -n ${namespace}`;

        // Add recent filter if requested
        if (recent) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const timestamp = yesterday.toISOString();
            command += ` --field-selector=metadata.creationTimestamp>=${timestamp}`;
        }

        command += " -o json";

        const { stdout } = await execAsync(command, {
            timeout: 10000,
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large outputs
        });
        const jsonResult = JSON.parse(stdout);
        return jsonResult.items || [];
    } catch (error: any) {
        if (error.code === 1 && error.stderr?.includes('No resources found')) {
            return [];
        }
        return [];
    }
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

function prioritizeNamespaces(namespaces: string[], query: string): string[] {
    const queryLower = query.toLowerCase();
    const prioritized: string[] = [];
    const regular: string[] = [];

    for (const namespace of namespaces) {
        const namespaceLower = namespace.toLowerCase();

        // High priority: namespace contains query term
        if (namespaceLower.includes(queryLower)) {
            prioritized.push(namespace);
        }
        // Medium priority: namespace contains common patterns related to query
        else if (
            (queryLower.includes('dev') && namespaceLower.includes('dev')) ||
            (queryLower.includes('prod') && namespaceLower.includes('prod')) ||
            (queryLower.includes('test') && namespaceLower.includes('test')) ||
            (queryLower.includes('demo') && namespaceLower.includes('demo'))
        ) {
            prioritized.push(namespace);
        }
        else {
            regular.push(namespace);
        }
    }

    return [...prioritized, ...regular];
}

async function streamingSearch(
    resourceTypes: string[],
    namespaces: string[],
    query: string,
    strategy: { type: string; selector: string },
    searchConfig: SearchConfig,
    includeLabels: boolean,
    includeAnnotations: boolean,
    recent: boolean,
    limit: number
): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const queryLower = query.toLowerCase();
    const batchSize = 50; // Process 50 namespaces per batch

    // Prioritize namespaces that might contain relevant resources
    const prioritizedNamespaces = prioritizeNamespaces(namespaces, query);

    // Quick pre-filter: if query is very specific, prioritize certain resource types
    const prioritizedResourceTypes = prioritizeResourceTypes(resourceTypes, query);

    for (const resourceType of prioritizedResourceTypes) {
        if (results.length >= limit) break;

        // Process namespaces in batches for better performance
        for (let i = 0; i < prioritizedNamespaces.length; i += batchSize) {
            if (results.length >= limit) break;

            const batch = prioritizedNamespaces.slice(i, i + batchSize);

            // Process this batch in parallel
            const batchPromises = batch.map(async (namespace) => {
                try {
                    const resources = await getResourcesWithPreFilter(resourceType, namespace);
                    if (resources.length === 0) return [];

                    // Quick scan for obvious matches first
                    const quickMatches = await quickScanResources(
                        resources,
                        resourceType,
                        namespace,
                        queryLower,
                        Math.min(10, limit - results.length) // Limit per namespace
                    );

                    const namespaceResults = [...quickMatches];

                    // If we don't have enough results, do deeper search on remaining resources
                    if (namespaceResults.length < 5 && quickMatches.length < resources.length) {
                        const remainingResources = resources.filter(r =>
                            !quickMatches.some(qm => qm.resource.metadata.name === r.metadata.name)
                        );

                        const deepMatches = await deepSearchResources(
                            remainingResources,
                            resourceType,
                            namespace,
                            query,
                            strategy,
                            searchConfig,
                            includeLabels,
                            includeAnnotations,
                            Math.min(3, limit - results.length - namespaceResults.length)
                        );

                        namespaceResults.push(...deepMatches);
                    }

                    return namespaceResults;
                } catch (error) {
                    // Continue with next namespace
                    return [];
                }
            });

            // Wait for all namespaces in this batch to complete
            const batchResults = await Promise.all(batchPromises);

            // Flatten and add results
            for (const namespaceResults of batchResults) {
                results.push(...namespaceResults);
                if (results.length >= limit) break;
            }

            // Early exit if we have enough results - don't process more batches
            if (results.length >= limit) break;
        }

        // Early exit if we have enough results - don't process more resource types
        if (results.length >= limit) break;
    }

    return results.slice(0, limit);
}

function prioritizeResourceTypes(resourceTypes: string[], query: string): string[] {
    const queryLower = query.toLowerCase();
    const priority: { [key: string]: number } = {};

    // Default priorities
    resourceTypes.forEach((rt, index) => {
        priority[rt] = index;
    });

    // Boost priority based on query hints
    if (queryLower.includes('pod') || queryLower.includes('container')) {
        priority['pods'] = -10;
    }
    if (queryLower.includes('service') || queryLower.includes('svc')) {
        priority['services'] = -9;
    }
    if (queryLower.includes('deploy') || queryLower.includes('app')) {
        priority['deployments'] = -8;
    }
    if (queryLower.includes('job')) {
        priority['jobs'] = -7;
        priority['cronjobs'] = -6;
    }

    return resourceTypes.sort((a, b) => priority[a] - priority[b]);
}

async function getResourcesWithPreFilter(
    resourceType: string,
    namespace: string,
    labelSelector?: string,
    fieldSelector?: string
): Promise<any[]> {
    try {
        let command = `kubectl get ${resourceType} -n ${namespace} -o json`;

        if (labelSelector) {
            command += ` -l "${labelSelector}"`;
        }

        if (fieldSelector) {
            command += ` --field-selector="${fieldSelector}"`;
        }

        const { stdout } = await execAsync(command, {
            timeout: 10000,
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer for large outputs
        });

        const parsed = JSON.parse(stdout);
        const items = parsed.items || [];

        return items;
    } catch (error: any) {
        return [];
    }
}

async function quickScanResources(
    resources: any[],
    resourceType: string,
    namespace: string,
    queryLower: string,
    maxResults: number
): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    for (const resource of resources) {
        if (results.length >= maxResults) break;

        const resourceName = resource.metadata.name.toLowerCase();

        // Only exact substring matches in quick scan
        if (resourceName.includes(queryLower)) {
            results.push({
                resource,
                resourceType,
                namespace,
                matchScore: 1.0,
                matchReason: "exact substring match in name",
                levenshteinDistance: 0
            });
        }
    }

    return results;
}

async function deepSearchResources(
    resources: any[],
    resourceType: string,
    namespace: string,
    query: string,
    strategy: { type: string; selector: string },
    searchConfig: SearchConfig,
    includeLabels: boolean,
    includeAnnotations: boolean,
    maxResults: number
): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const queryLower = query.toLowerCase();

    for (const resource of resources) {
        if (results.length >= maxResults) break;

        const resourceName = resource.metadata.name.toLowerCase();
        const matches = [];

        if (strategy.type === 'labels') {
            // Label selector search
            if (resource.metadata.labels) {
                for (const [key, value] of Object.entries(resource.metadata.labels)) {
                    const labelText = `${key}=${value}`.toLowerCase();
                    if (labelText.includes(queryLower)) {
                        matches.push({
                            score: 1.0,
                            reason: `label match (${key}=${value})`,
                            distance: 0
                        });
                        break;
                    }
                }
            }
        } else if (strategy.type === 'fields') {
            // Field selector search
            const fieldValue = getFieldValue(resource, strategy.selector);
            if (fieldValue && fieldValue.toString().toLowerCase().includes(queryLower)) {
                matches.push({
                    score: 1.0,
                    reason: `field match (${strategy.selector})`,
                    distance: 0
                });
            }
        } else if (strategy.type === 'exact') {
            // Exact pattern matching
            const regex = new RegExp(
                strategy.selector
                    .replace(/\*/g, '.*')
                    .replace(/\?/g, '.')
                    .replace(/\./g, '\\.')
                    .replace(/\.\*/g, '.*'),
                'i'
            );
            if (regex.test(resourceName)) {
                matches.push({
                    score: 1.0,
                    reason: "exact pattern match",
                    distance: 0
                });
            }
        } else {
            // Fuzzy matching with optimizations

            // Quick length check for Levenshtein
            const lengthDiff = Math.abs(queryLower.length - resourceName.length);
            if (lengthDiff <= searchConfig.maxDistance) {
                const distance = levenshteinDistance(queryLower, resourceName);
                if (distance <= searchConfig.maxDistance) {
                    const score = 1 - (distance / Math.max(queryLower.length, resourceName.length));
                    if (score >= searchConfig.minScore) {
                        matches.push({
                            score: score * 0.9,
                            reason: `fuzzy name match (distance: ${distance})`,
                            distance: distance
                        });
                    }
                }
            }

            // Word boundary matches
            if (matches.length === 0 && (resourceName.includes('-') || resourceName.includes('_'))) {
                const words = resourceName.split(/[-_\s]/);
                for (const word of words) {
                    if (word.includes(queryLower)) {
                        matches.push({
                            score: 0.8,
                            reason: "word boundary match in name",
                            distance: 0
                        });
                        break;
                    }
                }
            }

            // Acronym match - only for short queries
            if (matches.length === 0 && resourceName.includes('-') && queryLower.length <= 4) {
                const words = resourceName.split('-');
                if (words.length > 1) {
                    const acronym = words.map((w: string) => w[0]).join('');
                    if (acronym.includes(queryLower)) {
                        matches.push({
                            score: 0.6,
                            reason: "acronym match",
                            distance: 0
                        });
                    }
                }
            }

            // Label matching - only if enabled and no name matches
            if (matches.length === 0 && includeLabels && resource.metadata.labels) {
                for (const [key, value] of Object.entries(resource.metadata.labels)) {
                    const labelText = `${key}=${value}`.toLowerCase();
                    if (labelText.includes(queryLower)) {
                        matches.push({
                            score: 0.7,
                            reason: `label match (${key}=${value})`,
                            distance: 0
                        });
                        break;
                    }
                }
            }
        }

        // Get the best match
        if (matches.length > 0) {
            const bestMatch = matches.reduce((best, current) =>
                current.score > best.score ? current : best
            );

            results.push({
                resource,
                resourceType,
                namespace,
                matchScore: bestMatch.score,
                matchReason: bestMatch.reason,
                levenshteinDistance: bestMatch.distance
            });
        }
    }

    return results;
}

function getFieldValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
}

function levenshteinDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));

    for (let i = 0; i <= str1.length; i++) {
        matrix[0][i] = i;
    }

    for (let j = 0; j <= str2.length; j++) {
        matrix[j][0] = j;
    }

    for (let j = 1; j <= str2.length; j++) {
        for (let i = 1; i <= str1.length; i++) {
            const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
            matrix[j][i] = Math.min(
                matrix[j][i - 1] + 1, // deletion
                matrix[j - 1][i] + 1, // insertion
                matrix[j - 1][i - 1] + indicator // substitution
            );
        }
    }

    return matrix[str2.length][str1.length];
}

function sortResults(results: SearchResult[], sortBy: string): SearchResult[] {
    switch (sortBy) {
        case "name":
            return results.sort((a, b) => a.resource.metadata.name.localeCompare(b.resource.metadata.name));
        case "age":
            return results.sort((a, b) => {
                const ageA = new Date(a.resource.metadata.creationTimestamp).getTime();
                const ageB = new Date(b.resource.metadata.creationTimestamp).getTime();
                return ageB - ageA; // Newest first
            });
        case "namespace":
            return results.sort((a, b) => a.namespace.localeCompare(b.namespace));
        case "relevance":
        default:
            return results.sort((a, b) => b.matchScore - a.matchScore);
    }
}

function formatSearchResults(
    results: SearchResult[],
    output: string,
    query: string,
    searchType: string
): { content: Array<{ type: string; text: string }> } {

    if (output === "json") {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        query,
                        searchType,
                        totalResults: results.length,
                        results: results.map(r => ({
                            name: r.resource.metadata.name,
                            namespace: r.namespace,
                            resourceType: r.resourceType,
                            matchScore: r.matchScore,
                            matchReason: r.matchReason,
                            age: getResourceAge(r.resource.metadata.creationTimestamp),
                            status: getResourceStatus(r.resource)
                        }))
                    }, null, 2),
                },
            ],
        };
    }

    let outputText = `🔍 Search results for "${query}" (${results.length} matches):\n\n`;

    if (results.length === 0) {
        outputText += "No matches found. Try:\n";
        outputText += "• Using different keywords or partial names\n";
        outputText += "• Reducing fuzzy tolerance to 'loose'\n";
        outputText += "• Including more resource types\n";
        outputText += "• Checking if resources exist in the target namespaces\n";
        return {
            content: [{ type: "text", text: outputText }]
        };
    }

    if (output === "summary") {
        // Group by resource type
        const byType = new Map<string, SearchResult[]>();
        results.forEach(result => {
            if (!byType.has(result.resourceType)) {
                byType.set(result.resourceType, []);
            }
            byType.get(result.resourceType)!.push(result);
        });

        byType.forEach((typeResults, resourceType) => {
            outputText += `📦 ${resourceType.toUpperCase()} (${typeResults.length}):\n`;
            typeResults.forEach(result => {
                const score = (result.matchScore * 100).toFixed(0);
                const age = getResourceAge(result.resource.metadata.creationTimestamp);
                outputText += `  • ${result.resource.metadata.name}`;
                if (result.resourceType !== "namespace") {
                    outputText += ` (${result.namespace})`;
                }
                outputText += ` - ${score}% match, ${age}\n`;
            });
            outputText += "\n";
        });
    } else {
        // Detailed output
        results.forEach((result, index) => {
            const score = (result.matchScore * 100).toFixed(0);
            const age = getResourceAge(result.resource.metadata.creationTimestamp);
            const status = getResourceStatus(result.resource);

            outputText += `${index + 1}. 📋 ${result.resource.metadata.name}\n`;
            outputText += `   Type: ${result.resourceType}\n`;
            if (result.resourceType !== "namespace") {
                outputText += `   Namespace: ${result.namespace}\n`;
            }
            outputText += `   Match: ${score}% (${result.matchReason})\n`;
            outputText += `   Status: ${status}\n`;
            outputText += `   Age: ${age}\n`;

            if (result.resource.metadata.labels) {
                const labels = Object.entries(result.resource.metadata.labels)
                    .slice(0, 3) // Show first 3 labels
                    .map(([k, v]) => `${k}=${v}`)
                    .join(', ');
                if (labels) {
                    outputText += `   Labels: ${labels}\n`;
                }
            }
            outputText += "\n";
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