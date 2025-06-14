#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  installHelmChart,
  installHelmChartSchema,
  upgradeHelmChart,
  upgradeHelmChartSchema,
  uninstallHelmChart,
  uninstallHelmChartSchema,
} from "./tools/helm-operations.js";
import {
  explainResource,
  explainResourceSchema,
  listApiResources,
  listApiResourcesSchema,
} from "./tools/kubectl-operations.js";
import { getResourceHandlers } from "./resources/handlers.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import * as k8s from "@kubernetes/client-node";
import { KubernetesManager } from "./types.js";
import { serverConfig } from "./config/server-config.js";
import { cleanupSchema } from "./config/cleanup-config.js";
import { startSSEServer } from "./utils/sse.js";
import {
  startPortForward,
  PortForwardSchema,
  stopPortForward,
  StopPortForwardSchema,
} from "./tools/port_forward.js";
import { kubectlScale, kubectlScaleSchema } from "./tools/kubectl-scale.js";
import { kubectlContext, kubectlContextSchema } from "./tools/kubectl-context.js";
import { kubectlGet, kubectlGetSchema } from "./tools/kubectl-get.js";
import { kubectlDescribe, kubectlDescribeSchema } from "./tools/kubectl-describe.js";
import { kubectlList, kubectlListSchema } from "./tools/kubectl-list.js";
import { kubectlApply, kubectlApplySchema } from "./tools/kubectl-apply.js";
import { kubectlDelete, kubectlDeleteSchema } from "./tools/kubectl-delete.js";
import { kubectlCreate, kubectlCreateSchema } from "./tools/kubectl-create.js";
import { kubectlLogs, kubectlLogsSchema } from "./tools/kubectl-logs.js";
import { kubectlGeneric, kubectlGenericSchema } from "./tools/kubectl-generic.js";
import { kubectlPatch, kubectlPatchSchema } from "./tools/kubectl-patch.js";
import { kubectlRollout, kubectlRolloutSchema } from "./tools/kubectl-rollout.js";
import { kubectlNvidiaSmi, kubectlNvidiaSmiSchema } from "./tools/kubectl-nvidia-smi.js";
import {
  kubectlCurl,
  kubectlCurlSchema,
  kubectlPing,
  kubectlPingSchema,
  kubectlTraceroute,
  kubectlTracerouteSchema
} from "./tools/kubectl-exec.js";
import {
  listKubeconfigFiles,
  listKubeconfigFilesSchema,
  switchKubeconfig,
  switchKubeconfigSchema,
  ListKubeconfigFilesInput,
  SwitchKubeconfigInput
} from "./tools/kubeconfig-ops.js";

// Check if non-destructive tools only mode is enabled
const nonDestructiveTools =
  process.env.ALLOW_ONLY_NON_DESTRUCTIVE_TOOLS === "true";

// Define destructive tools (delete and uninstall operations)
const destructiveTools = [
  kubectlDeleteSchema, // This replaces all individual delete operations 
  uninstallHelmChartSchema,
  cleanupSchema, // Cleanup is also destructive as it deletes resources
  kubectlGenericSchema, // Generic kubectl command can perform destructive operations
];

// Get all available tools
const allTools = [
  // Core operation tools
  cleanupSchema,

  // Unified kubectl-style tools - these replace many specific tools
  kubectlGetSchema,
  kubectlDescribeSchema,
  kubectlListSchema,
  kubectlApplySchema,
  kubectlDeleteSchema,
  kubectlCreateSchema,
  kubectlLogsSchema,
  kubectlScaleSchema,
  kubectlPatchSchema,
  kubectlRolloutSchema,
  kubectlNvidiaSmiSchema,

  // kubectl exec tools for network diagnostics
  kubectlCurlSchema,
  kubectlPingSchema,
  kubectlTracerouteSchema,

  // Kubernetes context management
  kubectlContextSchema,

  // Kubeconfig management tools
  listKubeconfigFilesSchema,
  switchKubeconfigSchema,

  // Special operations that aren't covered by simple kubectl commands
  explainResourceSchema,

  // Helm operations
  installHelmChartSchema,
  upgradeHelmChartSchema,
  uninstallHelmChartSchema,

  // Port forwarding
  PortForwardSchema,
  StopPortForwardSchema,

  // API resource operations
  listApiResourcesSchema,

  // Generic kubectl command
  kubectlGenericSchema,
];

const k8sManager = new KubernetesManager();

const server = new Server(
  {
    name: serverConfig.name,
    version: serverConfig.version,
  },
  serverConfig
);

// Resources handlers
const resourceHandlers = getResourceHandlers(k8sManager);
server.setRequestHandler(
  ListResourcesRequestSchema,
  resourceHandlers.listResources
);
server.setRequestHandler(
  ReadResourceRequestSchema,
  resourceHandlers.readResource
);

// Tools handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Filter out destructive tools if ALLOW_ONLY_NON_DESTRUCTIVE_TOOLS is set to 'true'
  const tools = nonDestructiveTools
    ? allTools.filter(
      (tool) => !destructiveTools.some((dt) => dt.name === tool.name)
    )
    : allTools;

  return { tools };
});

server.setRequestHandler(
  CallToolRequestSchema,
  async (request: {
    params: { name: string; _meta?: any; arguments?: any };
    method: string;
  }) => {
    try {
      const { name, arguments: rawInput } = request.params;

      // Handle different argument formats that might come from various MCP clients
      let input: Record<string, any> = {};

      if (rawInput) {
        if (typeof rawInput === 'string') {
          // If arguments is a string, try to parse it as JSON
          try {
            if (rawInput.trim() === '') {
              input = {};
            } else {
              input = JSON.parse(rawInput);
            }
          } catch (parseError) {
            console.error(`Failed to parse arguments as JSON: ${rawInput}`, parseError);
            input = {};
          }
        } else if (typeof rawInput === 'object') {
          input = rawInput;
        }
      }

      // Handle kubeconfig management tools
      if (name === "list_kubeconfig_files") {
        try {
          return await listKubeconfigFiles(input as ListKubeconfigFilesInput);
        } catch (error: any) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  error: `Failed to list kubeconfig files: ${error.message}`,
                  tool: "list_kubeconfig_files"
                }, null, 2)
              }
            ]
          };
        }
      }

      if (name === "switch_kubeconfig") {
        try {
          return await switchKubeconfig(input as SwitchKubeconfigInput);
        } catch (error: any) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  error: `Failed to switch kubeconfig: ${error.message}`,
                  tool: "switch_kubeconfig"
                }, null, 2)
              }
            ]
          };
        }
      }

      // Handle new kubectl-style commands
      if (name === "kubectl_context") {
        return await kubectlContext(k8sManager, input as {
          operation: "list" | "get" | "set";
          name?: string;
          showCurrent?: boolean;
          detailed?: boolean;
          output?: string;
        });
      }

      if (name === "kubectl_get") {
        return await kubectlGet(k8sManager, input as {
          resourceType: string;
          name?: string;
          namespace?: string;
          output?: string;
          allNamespaces?: boolean;
          labelSelector?: string;
          fieldSelector?: string;
        });
      }

      if (name === "kubectl_describe") {
        return await kubectlDescribe(k8sManager, input as {
          resourceType: string;
          name: string;
          namespace?: string;
          allNamespaces?: boolean;
        });
      }

      if (name === "kubectl_list") {
        return await kubectlList(k8sManager, input as {
          resourceType: string;
          namespace?: string;
          output?: string;
          allNamespaces?: boolean;
          labelSelector?: string;
          fieldSelector?: string;
        });
      }

      if (name === "kubectl_apply") {
        return await kubectlApply(k8sManager, input as {
          manifest?: string;
          filename?: string;
          namespace?: string;
          dryRun?: boolean;
          force?: boolean;
        });
      }

      if (name === "kubectl_delete") {
        return await kubectlDelete(k8sManager, input as {
          resourceType?: string;
          name?: string;
          namespace?: string;
          labelSelector?: string;
          manifest?: string;
          filename?: string;
          allNamespaces?: boolean;
          force?: boolean;
          gracePeriodSeconds?: number;
        });
      }

      if (name === "kubectl_create") {
        return await kubectlCreate(k8sManager, input as {
          manifest?: string;
          filename?: string;
          namespace?: string;
          dryRun?: boolean;
          validate?: boolean;
        });
      }

      if (name === "kubectl_logs") {
        return await kubectlLogs(k8sManager, input as {
          resourceType: string;
          name: string;
          namespace: string;
          container?: string;
          tail?: number;
          since?: string;
          sinceTime?: string;
          timestamps?: boolean;
          previous?: boolean;
          follow?: boolean;
          labelSelector?: string;
        });
      }

      if (name === "kubectl_patch") {
        return await kubectlPatch(k8sManager, input as {
          resourceType: string;
          name: string;
          namespace?: string;
          patchType?: "strategic" | "merge" | "json";
          patchData?: object;
          patchFile?: string;
          dryRun?: boolean;
        });
      }

      if (name === "kubectl_rollout") {
        return await kubectlRollout(k8sManager, input as {
          subCommand: "history" | "pause" | "restart" | "resume" | "status" | "undo";
          resourceType: "deployment" | "daemonset" | "statefulset";
          name: string;
          namespace?: string;
          revision?: number;
          toRevision?: number;
          timeout?: string;
          watch?: boolean;
        });
      }

      if (name === "kubectl_nvidia_smi") {
        return await kubectlNvidiaSmi(k8sManager, input as {
          podName: string;
          namespace?: string;
          container?: string;
          outputFormat?: "json" | "text";
          queryGpu?: string;
        });
      }

      if (name === "kubectl_curl") {
        return await kubectlCurl(k8sManager, input as {
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
        });
      }

      if (name === "kubectl_ping") {
        return await kubectlPing(k8sManager, input as {
          podName: string;
          namespace?: string;
          container?: string;
          target: string;
          count?: number;
          interval?: number;
          timeout?: number;
        });
      }

      if (name === "kubectl_traceroute") {
        return await kubectlTraceroute(k8sManager, input as {
          podName: string;
          namespace?: string;
          container?: string;
          target: string;
          maxHops?: number;
          timeout?: number;
        });
      }

      if (name === "kubectl_generic") {
        return await kubectlGeneric(k8sManager, input as {
          command: string;
          subCommand?: string;
          resourceType?: string;
          name?: string;
          namespace?: string;
          outputFormat?: string;
          flags?: Record<string, any>;
          args?: string[];
        });
      }

      if (name === "kubectl_events") {
        return await kubectlGet(k8sManager, {
          resourceType: "events",
          namespace: (input as { namespace?: string }).namespace,
          fieldSelector: (input as { fieldSelector?: string }).fieldSelector,
          labelSelector: (input as { labelSelector?: string }).labelSelector,
          sortBy: (input as { sortBy?: string }).sortBy,
          output: (input as { output?: string }).output
        });
      }

      // Handle specific non-kubectl operations
      switch (name) {
        case "cleanup": {
          await k8sManager.cleanup();
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    success: true,
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        case "explain_resource": {
          return await explainResource(
            input as {
              resource: string;
              apiVersion?: string;
              recursive?: boolean;
              output?: "plaintext" | "plaintext-openapiv2";
            }
          );
        }

        case "install_helm_chart": {
          return await installHelmChart(
            input as {
              name: string;
              chart: string;
              repo: string;
              namespace: string;
              values?: Record<string, any>;
            }
          );
        }

        case "uninstall_helm_chart": {
          return await uninstallHelmChart(
            input as {
              name: string;
              namespace: string;
            }
          );
        }

        case "upgrade_helm_chart": {
          return await upgradeHelmChart(
            input as {
              name: string;
              chart: string;
              repo: string;
              namespace: string;
              values?: Record<string, any>;
            }
          );
        }

        case "list_api_resources": {
          return await listApiResources(
            input as {
              apiGroup?: string;
              namespaced?: boolean;
              verbs?: string[];
              output?: "wide" | "name" | "no-headers";
            }
          );
        }

        case "port_forward": {
          return await startPortForward(
            k8sManager,
            input as {
              resourceType: string;
              resourceName: string;
              localPort: number;
              targetPort: number;
            }
          );
        }

        case "stop_port_forward": {
          return await stopPortForward(
            k8sManager,
            input as {
              id: string;
            }
          );
        }

        case "kubectl_scale": {
          return await kubectlScale(
            k8sManager,
            input as {
              name: string;
              namespace?: string;
              replicas: number;
              resourceType?: string;
            }
          );
        }

        default:
          throw new McpError(ErrorCode.InvalidRequest, `Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(
        ErrorCode.InternalError,
        `Tool execution failed: ${error}`
      );
    }
  }
);

// Start the server
if (process.env.ENABLE_UNSAFE_SSE_TRANSPORT) {
  startSSEServer(server);
  console.log(`SSE server started`);
} else {
  const transport = new StdioServerTransport();

  console.error(
    `Starting Kubernetes MCP server v${serverConfig.version}, handling commands...`
  );

  server.connect(transport);
}

["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, async () => {
    console.log(`Received ${signal}, shutting down...`);
    await server.close();
    process.exit(0);
  });
});

export { allTools, destructiveTools };
