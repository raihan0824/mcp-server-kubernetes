import { KubernetesManager } from "../types.js";
import { execSync } from "child_process";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

// Helper function to execute commands in pods
async function executeInPod(
    k8sManager: KubernetesManager,
    input: {
        podName: string;
        namespace?: string;
        container?: string;
        command: string;
        timeout?: number;
    }
) {
    const namespace = input.namespace || "default";
    const timeout = input.timeout || 30;

    // First, check if the pod exists
    try {
        const checkPodCommand = `kubectl get pod ${input.podName} -n ${namespace} --no-headers`;
        execSync(checkPodCommand, { encoding: "utf8" });
    } catch (error: any) {
        throw new McpError(
            ErrorCode.InvalidRequest,
            `Pod '${input.podName}' not found in namespace '${namespace}': ${error.message}`
        );
    }

    // Build the kubectl exec command
    let kubectlCommand = `kubectl exec -it ${input.podName} -n ${namespace}`;

    // Add container if specified
    if (input.container) {
        kubectlCommand += ` -c ${input.container}`;
    }

    // Add the command to execute
    kubectlCommand += ` -- bash -c "${input.command}"`;

    console.error(`Executing: ${kubectlCommand}`);

    try {
        const result = execSync(kubectlCommand, {
            encoding: "utf8",
            timeout: timeout * 1000 // Convert to milliseconds
        });

        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        pod: input.podName,
                        namespace: namespace,
                        container: input.container,
                        command: input.command,
                        output: result.trim(),
                        success: true
                    }, null, 2),
                },
            ],
        };
    } catch (error: any) {
        // Handle specific command errors
        if (error.message.includes("command not found")) {
            const commandType = input.command.split(' ')[0];
            throw new McpError(
                ErrorCode.InvalidRequest,
                `${commandType} command not found in pod '${input.podName}'. The pod may not have the required tools installed.`
            );
        } else if (error.message.includes("container not found")) {
            throw new McpError(
                ErrorCode.InvalidRequest,
                `Container '${input.container}' not found in pod '${input.podName}'. Available containers can be checked with kubectl describe.`
            );
        } else if (error.code === "ETIMEDOUT") {
            throw new McpError(
                ErrorCode.InternalError,
                `Command execution timed out after ${timeout} seconds in pod '${input.podName}'`
            );
        } else {
            // For network commands, we might still want to return the error output as it could be informative
            const errorOutput = error.stdout || error.stderr || error.message;
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            pod: input.podName,
                            namespace: namespace,
                            container: input.container,
                            command: input.command,
                            output: errorOutput,
                            success: false,
                            error: `Command failed: ${error.message}`
                        }, null, 2),
                    },
                ],
            };
        }
    }
}

export const kubectlCurlSchema = {
    name: "kubectl_curl",
    description: "Execute curl command inside a Kubernetes pod to test HTTP/HTTPS connectivity",
    inputSchema: {
        type: "object",
        properties: {
            podName: {
                type: "string",
                description: "Name of the pod to execute curl in",
            },
            namespace: {
                type: "string",
                description: "Namespace of the pod",
                default: "default",
            },
            container: {
                type: "string",
                description: "Container name (optional, required for multi-container pods)",
                optional: true,
            },
            url: {
                type: "string",
                description: "Target URL to curl",
            },
            method: {
                type: "string",
                enum: ["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS"],
                description: "HTTP method",
                default: "GET",
                optional: true,
            },
            headers: {
                type: "array",
                items: { type: "string" },
                description: "HTTP headers (e.g., ['Content-Type: application/json', 'Authorization: Bearer token'])",
                optional: true,
            },
            data: {
                type: "string",
                description: "Request body data for POST/PUT requests",
                optional: true,
            },
            followRedirects: {
                type: "boolean",
                description: "Follow HTTP redirects",
                default: true,
                optional: true,
            },
            timeout: {
                type: "number",
                description: "Request timeout in seconds",
                default: 30,
                optional: true,
            },
            verbose: {
                type: "boolean",
                description: "Enable verbose output",
                default: false,
                optional: true,
            }
        },
        required: ["podName", "url"],
    },
} as const;

export async function kubectlCurl(
    k8sManager: KubernetesManager,
    input: {
        podName: string;
        namespace?: string;
        container?: string;
        url: string;
        method?: string;
        headers?: string[];
        data?: string;
        followRedirects?: boolean;
        timeout?: number;
        verbose?: boolean;
    }
) {
    try {
        // Build curl command with options
        let curlOptions = [];

        if (input.method && input.method !== "GET") {
            curlOptions.push(`-X ${input.method}`);
        }

        if (input.headers) {
            input.headers.forEach(header => {
                curlOptions.push(`-H "${header}"`);
            });
        }

        if (input.data) {
            curlOptions.push(`-d '${input.data}'`);
        }

        if (input.followRedirects !== false) {
            curlOptions.push("-L");
        }

        if (input.timeout) {
            curlOptions.push(`--max-time ${input.timeout}`);
        }

        if (input.verbose) {
            curlOptions.push("-v");
        }

        // Always include some useful options
        curlOptions.push("-s", "-S"); // Silent but show errors

        const curlCommand = `curl ${curlOptions.join(" ")} "${input.url}"`;

        return executeInPod(k8sManager, {
            podName: input.podName,
            namespace: input.namespace,
            container: input.container,
            command: curlCommand,
            timeout: (input.timeout || 30) + 5 // Add 5 seconds buffer for kubectl overhead
        });
    } catch (error: any) {
        if (error instanceof McpError) {
            throw error;
        }

        throw new McpError(
            ErrorCode.InternalError,
            `kubectl curl operation failed: ${error.message}`
        );
    }
}

export const kubectlPingSchema = {
    name: "kubectl_ping",
    description: "Execute ping command inside a Kubernetes pod to test network connectivity",
    inputSchema: {
        type: "object",
        properties: {
            podName: {
                type: "string",
                description: "Name of the pod to execute ping in",
            },
            namespace: {
                type: "string",
                description: "Namespace of the pod",
                default: "default",
            },
            container: {
                type: "string",
                description: "Container name (optional, required for multi-container pods)",
                optional: true,
            },
            target: {
                type: "string",
                description: "Target IP address or hostname to ping",
            },
            count: {
                type: "number",
                description: "Number of ping packets to send",
                default: 4,
                optional: true,
            },
            interval: {
                type: "number",
                description: "Interval between pings in seconds",
                optional: true,
            },
            timeout: {
                type: "number",
                description: "Timeout for each ping in seconds",
                optional: true,
            }
        },
        required: ["podName", "target"],
    },
} as const;

export async function kubectlPing(
    k8sManager: KubernetesManager,
    input: {
        podName: string;
        namespace?: string;
        container?: string;
        target: string;
        count?: number;
        interval?: number;
        timeout?: number;
    }
) {
    try {
        // Build ping options
        let pingOptions = [];

        if (input.count) {
            pingOptions.push(`-c ${input.count}`);
        } else {
            pingOptions.push("-c 4"); // Default to 4 pings
        }

        if (input.interval) {
            pingOptions.push(`-i ${input.interval}`);
        }

        if (input.timeout) {
            pingOptions.push(`-W ${input.timeout}`);
        }

        const pingCommand = `ping ${pingOptions.join(" ")} ${input.target}`;

        return executeInPod(k8sManager, {
            podName: input.podName,
            namespace: input.namespace,
            container: input.container,
            command: pingCommand,
            timeout: ((input.count || 4) * (input.interval || 1) + 10) // Calculate reasonable timeout
        });
    } catch (error: any) {
        if (error instanceof McpError) {
            throw error;
        }

        throw new McpError(
            ErrorCode.InternalError,
            `kubectl ping operation failed: ${error.message}`
        );
    }
}

export const kubectlTracerouteSchema = {
    name: "kubectl_traceroute",
    description: "Execute traceroute command inside a Kubernetes pod to trace network path",
    inputSchema: {
        type: "object",
        properties: {
            podName: {
                type: "string",
                description: "Name of the pod to execute traceroute in",
            },
            namespace: {
                type: "string",
                description: "Namespace of the pod",
                default: "default",
            },
            container: {
                type: "string",
                description: "Container name (optional, required for multi-container pods)",
                optional: true,
            },
            target: {
                type: "string",
                description: "Target IP address or hostname to traceroute",
            },
            maxHops: {
                type: "number",
                description: "Maximum number of hops",
                default: 30,
                optional: true,
            },
            timeout: {
                type: "number",
                description: "Timeout for the entire traceroute operation in seconds",
                default: 60,
                optional: true,
            }
        },
        required: ["podName", "target"],
    },
} as const;

export async function kubectlTraceroute(
    k8sManager: KubernetesManager,
    input: {
        podName: string;
        namespace?: string;
        container?: string;
        target: string;
        maxHops?: number;
        timeout?: number;
    }
) {
    try {
        // Build traceroute options
        let tracerouteOptions = [];

        if (input.maxHops) {
            tracerouteOptions.push(`-m ${input.maxHops}`);
        }

        const tracerouteCommand = `traceroute ${tracerouteOptions.join(" ")} ${input.target}`;

        return executeInPod(k8sManager, {
            podName: input.podName,
            namespace: input.namespace,
            container: input.container,
            command: tracerouteCommand,
            timeout: input.timeout || 60
        });
    } catch (error: any) {
        if (error instanceof McpError) {
            throw error;
        }

        throw new McpError(
            ErrorCode.InternalError,
            `kubectl traceroute operation failed: ${error.message}`
        );
    }
} 