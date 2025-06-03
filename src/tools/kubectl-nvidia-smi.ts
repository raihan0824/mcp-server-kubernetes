import { KubernetesManager } from "../types.js";
import { execSync } from "child_process";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export const kubectlNvidiaSmiSchema = {
    name: "kubectl_nvidia_smi",
    description: "Execute nvidia-smi command inside a Kubernetes pod to check GPU status and usage",
    inputSchema: {
        type: "object",
        properties: {
            podName: {
                type: "string",
                description: "Name of the pod to execute nvidia-smi in",
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
            outputFormat: {
                type: "string",
                enum: ["json", "text"],
                description: "Output format for nvidia-smi command",
                default: "text",
            },
            queryGpu: {
                type: "string",
                description: "Specific nvidia-smi query options (e.g., 'gpu', 'memory', 'utilization')",
                optional: true,
            }
        },
        required: ["podName"],
    },
} as const;

export async function kubectlNvidiaSmi(
    k8sManager: KubernetesManager,
    input: {
        podName: string;
        namespace?: string;
        container?: string;
        outputFormat?: "json" | "text";
        queryGpu?: string;
    }
) {
    try {
        const namespace = input.namespace || "default";
        const outputFormat = input.outputFormat || "text";

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

        // Build the nvidia-smi command based on output format and query options
        let nvidiaSmiCommand = "nvidia-smi";

        if (outputFormat === "json") {
            nvidiaSmiCommand += " --query-gpu=index,name,driver_version,memory.total,memory.used,memory.free,utilization.gpu,utilization.memory,temperature.gpu --format=csv,noheader,nounits";
        } else if (input.queryGpu) {
            // Custom query for specific GPU information
            nvidiaSmiCommand += ` --query-gpu=${input.queryGpu} --format=csv,noheader,nounits`;
        }

        // Build the kubectl exec command
        let kubectlCommand = `kubectl exec -it ${input.podName} -n ${namespace}`;

        // Add container if specified
        if (input.container) {
            kubectlCommand += ` -c ${input.container}`;
        }

        // Add the nvidia-smi command
        kubectlCommand += ` -- bash -c "${nvidiaSmiCommand}"`;

        console.error(`Executing: ${kubectlCommand}`);

        try {
            const result = execSync(kubectlCommand, { encoding: "utf8" });

            if (outputFormat === "json") {
                // Parse CSV output and convert to JSON
                const jsonResult = parseNvidiaSmiCsvToJson(result);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                pod: input.podName,
                                namespace: namespace,
                                container: input.container,
                                gpuInfo: jsonResult
                            }, null, 2),
                        },
                    ],
                };
            } else {
                // Return raw text output
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                pod: input.podName,
                                namespace: namespace,
                                container: input.container,
                                nvidiaSmiOutput: result.trim()
                            }, null, 2),
                        },
                    ],
                };
            }
        } catch (error: any) {
            // Handle specific nvidia-smi related errors
            if (error.message.includes("nvidia-smi: command not found")) {
                throw new McpError(
                    ErrorCode.InvalidRequest,
                    `nvidia-smi command not found in pod '${input.podName}'. This pod may not have NVIDIA GPU drivers installed.`
                );
            } else if (error.message.includes("No devices were found")) {
                throw new McpError(
                    ErrorCode.InvalidRequest,
                    `No NVIDIA GPU devices found in pod '${input.podName}'. The pod may not have access to GPU resources.`
                );
            } else if (error.message.includes("container not found")) {
                throw new McpError(
                    ErrorCode.InvalidRequest,
                    `Container '${input.container}' not found in pod '${input.podName}'. Available containers can be checked with kubectl describe.`
                );
            } else {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Failed to execute nvidia-smi in pod '${input.podName}': ${error.message}`
                );
            }
        }
    } catch (error: any) {
        if (error instanceof McpError) {
            throw error;
        }

        throw new McpError(
            ErrorCode.InternalError,
            `kubectl nvidia-smi operation failed: ${error.message}`
        );
    }
}

// Helper function to parse nvidia-smi CSV output to JSON
function parseNvidiaSmiCsvToJson(csvOutput: string) {
    const lines = csvOutput.trim().split('\n');
    const gpus = [];

    for (const line of lines) {
        if (line.trim() === '') continue;

        const values = line.split(',').map(v => v.trim());
        if (values.length >= 9) {
            gpus.push({
                index: parseInt(values[0]) || 0,
                name: values[1] || "Unknown",
                driverVersion: values[2] || "Unknown",
                memory: {
                    total: `${values[3]} MB`,
                    used: `${values[4]} MB`,
                    free: `${values[5]} MB`
                },
                utilization: {
                    gpu: `${values[6]}%`,
                    memory: `${values[7]}%`
                },
                temperature: `${values[8]}°C`
            });
        }
    }

    return gpus;
} 