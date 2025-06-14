import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { z } from 'zod';
import * as yaml from 'js-yaml';

// Schema for listing kubeconfig files
export const listKubeconfigFilesSchema = {
    name: "list_kubeconfig_files",
    description: "List all kubeconfig files in ~/.kube directory with cluster server information",
    inputSchema: {
        type: "object",
        properties: {
            kubeconfigDir: {
                type: "string",
                description: "Directory path to search for kubeconfig files (defaults to ~/.kube)",
                default: "~/.kube"
            }
        },
        additionalProperties: false
    }
};

// Schema for switching kubeconfig
export const switchKubeconfigSchema = {
    name: "switch_kubeconfig",
    description: "Overwrite the main kubeconfig file (~/.kube/config) with contents from another kubeconfig file",
    inputSchema: {
        type: "object",
        properties: {
            sourceFile: {
                type: "string",
                description: "Name of the source kubeconfig file (e.g., 'config-dev.yaml'). Must exist in the kubeconfig directory."
            },
            kubeconfigDir: {
                type: "string",
                description: "Directory path containing kubeconfig files (defaults to ~/.kube)",
                default: "~/.kube"
            }
        },
        required: ["sourceFile"],
        additionalProperties: false
    }
};

// Input type definitions
export type ListKubeconfigFilesInput = {
    kubeconfigDir?: string;
};

export type SwitchKubeconfigInput = {
    sourceFile: string;
    kubeconfigDir?: string;
};

// Type definitions for kubeconfig structure
interface KubeconfigCluster {
    cluster: {
        server: string;
        [key: string]: any;
    };
    name: string;
}

interface KubeconfigContext {
    context: {
        cluster: string;
        user: string;
        namespace?: string;
    };
    name: string;
}

interface Kubeconfig {
    apiVersion: string;
    kind?: string;
    clusters: KubeconfigCluster[];
    contexts: KubeconfigContext[];
    'current-context'?: string;
    users?: any[];
}

/**
 * Expand tilde (~) to home directory
 */
function expandTilde(filePath: string): string {
    if (filePath.startsWith('~/')) {
        return join(homedir(), filePath.slice(2));
    }
    return filePath;
}

/**
 * Parse kubeconfig file and extract cluster information
 */
async function parseKubeconfigFile(filePath: string): Promise<{
    clusters: Array<{ name: string; server: string }>;
    currentContext?: string;
    currentCluster?: string;
    error?: string;
}> {
    try {
        const fileContent = await fs.readFile(filePath, 'utf8');
        const config = yaml.load(fileContent) as Kubeconfig;

        if (!config || !config.clusters) {
            return { clusters: [], error: 'Invalid kubeconfig format' };
        }

        const clusters = config.clusters.map(cluster => ({
            name: cluster.name,
            server: cluster.cluster.server
        }));

        let currentCluster: string | undefined;
        if (config['current-context'] && config.contexts) {
            const currentContextObj = config.contexts.find(ctx => ctx.name === config['current-context']);
            if (currentContextObj) {
                currentCluster = currentContextObj.context.cluster;
            }
        }

        return {
            clusters,
            currentContext: config['current-context'],
            currentCluster
        };
    } catch (error: any) {
        return {
            clusters: [],
            error: `Failed to parse kubeconfig: ${error.message}`
        };
    }
}

/**
 * List all kubeconfig files in the specified directory
 */
export async function listKubeconfigFiles(input: ListKubeconfigFilesInput) {
    const kubeconfigDir = expandTilde(input.kubeconfigDir || '~/.kube');

    try {
        // Check if directory exists
        await fs.access(kubeconfigDir);

        // Read directory contents
        const files = await fs.readdir(kubeconfigDir, { withFileTypes: true });

        // Filter for files only (not directories) and exclude system files
        const configFiles = files
            .filter(dirent => dirent.isFile())
            .map(dirent => dirent.name)
            .filter(filename => {
                // Exclude system files and non-kubeconfig files
                return !filename.startsWith('.') &&
                    !filename.endsWith('.log') &&
                    !filename.endsWith('.tmp') &&
                    !filename.endsWith('.bak');
            })
            .sort();

        // Get file stats and parse kubeconfig for each file
        const fileDetails = await Promise.all(
            configFiles.map(async (filename) => {
                const filePath = join(kubeconfigDir, filename);

                try {
                    const stats = await fs.stat(filePath);

                    // Parse kubeconfig to get cluster information
                    const kubeconfigInfo = await parseKubeconfigFile(filePath);

                    return {
                        name: filename,
                        size: stats.size,
                        modified: stats.mtime.toISOString(),
                        isCurrentConfig: filename === 'config',
                        clusters: kubeconfigInfo.clusters,
                        currentContext: kubeconfigInfo.currentContext,
                        currentCluster: kubeconfigInfo.currentCluster,
                        parseError: kubeconfigInfo.error
                    };
                } catch (error: any) {
                    // If we can't read the file, skip it
                    return null;
                }
            })
        );

        // Filter out null entries (files we couldn't read)
        const validFileDetails = fileDetails.filter(detail => detail !== null);

        // Return the same structure as other tools
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        success: true,
                        directory: kubeconfigDir,
                        files: validFileDetails,
                        totalFiles: validFileDetails.length
                    }, null, 2)
                }
            ]
        };

    } catch (error: any) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        success: false,
                        error: `Failed to list kubeconfig files: ${error.message}`,
                        directory: kubeconfigDir
                    }, null, 2)
                }
            ]
        };
    }
}

/**
 * Switch kubeconfig by overwriting the main config file with another file
 */
export async function switchKubeconfig(input: SwitchKubeconfigInput) {
    const kubeconfigDir = expandTilde(input.kubeconfigDir || '~/.kube');
    const sourceFile = input.sourceFile;

    const sourcePath = join(kubeconfigDir, sourceFile);
    const configPath = join(kubeconfigDir, 'config');

    try {
        // Check if source file exists
        await fs.access(sourcePath);

        // Check if source file is readable
        const sourceStats = await fs.stat(sourcePath);
        if (!sourceStats.isFile()) {
            throw new Error(`Source '${sourceFile}' is not a file`);
        }

        // Parse source kubeconfig to get cluster information
        const sourceKubeconfigInfo = await parseKubeconfigFile(sourcePath);

        // Get previous config info if it exists (for informational purposes)
        let previousKubeconfigInfo = null;
        try {
            await fs.access(configPath);
            previousKubeconfigInfo = await parseKubeconfigFile(configPath);
        } catch (error) {
            // Config file doesn't exist, that's fine
        }

        // Copy source file to config
        await fs.copyFile(sourcePath, configPath);

        // Verify the copy was successful
        const newConfigStats = await fs.stat(configPath);

        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        success: true,
                        message: `Successfully switched kubeconfig to '${sourceFile}'`,
                        sourceFile: sourceFile,
                        sourcePath: sourcePath,
                        configPath: configPath,
                        newConfigSize: newConfigStats.size,
                        timestamp: new Date().toISOString(),
                        // Include cluster information
                        newClusters: sourceKubeconfigInfo.clusters,
                        newCurrentContext: sourceKubeconfigInfo.currentContext,
                        newCurrentCluster: sourceKubeconfigInfo.currentCluster,
                        previousClusters: previousKubeconfigInfo?.clusters || [],
                        previousCurrentContext: previousKubeconfigInfo?.currentContext,
                        previousCurrentCluster: previousKubeconfigInfo?.currentCluster
                    }, null, 2)
                }
            ]
        };

    } catch (error: any) {
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        success: false,
                        error: `Failed to switch kubeconfig: ${error.message}`,
                        sourceFile: sourceFile,
                        sourcePath: sourcePath,
                        configPath: configPath
                    }, null, 2)
                }
            ]
        };
    }
} 