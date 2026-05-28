import { loadConfig } from "../core/config.js";
import {
  listOpenAiModels,
  probeOpenAiEndpoints,
  type OpenAiEndpointProbe
} from "../providers/openai.js";

interface CliOptions {
  live: boolean;
  json: boolean;
  chatModel?: string;
  responsesModel?: string;
  embeddingModel?: string;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const models = await loadModelsForSelection(config, options.live);
  const chatModel = options.chatModel ?? options.responsesModel ?? selectTextModel(models, config.models[0]?.modelName);
  const responsesModel = options.responsesModel ?? options.chatModel ?? chatModel;
  const embeddingModel = options.embeddingModel ?? selectEmbeddingModel(models);

  const probes = await probeOpenAiEndpoints(config, {
    live: options.live,
    chatModel,
    responsesModel,
    embeddingModel
  });

  if (options.json) {
    console.log(JSON.stringify({
      baseUrl: config.openaiBaseUrl,
      live: options.live,
      selectedModels: {
        chat: chatModel,
        responses: responsesModel,
        embeddings: embeddingModel
      },
      probes
    }, null, 2));
  } else {
    printReport(config.openaiBaseUrl, options.live, probes, {
      chat: chatModel,
      responses: responsesModel,
      embeddings: embeddingModel
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed to test OpenAI endpoints");
  process.exitCode = 1;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    live: false,
    json: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--live") {
      options.live = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--model") {
      const value = readOptionValue(args, index, arg);
      options.chatModel = value;
      options.responsesModel = value;
      index += 1;
    } else if (arg === "--chat-model") {
      options.chatModel = readOptionValue(args, index, arg);
      index += 1;
    } else if (arg === "--responses-model") {
      options.responsesModel = readOptionValue(args, index, arg);
      index += 1;
    } else if (arg === "--embedding-model") {
      options.embeddingModel = readOptionValue(args, index, arg);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function readOptionValue(args: string[], index: number, optionName: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

async function loadModelsForSelection(
  config: Parameters<typeof listOpenAiModels>[0],
  live: boolean
): Promise<string[]> {
  if (!live) return [];

  try {
    return (await listOpenAiModels(config)).map((model) => model.id);
  } catch {
    return [];
  }
}

function selectTextModel(modelIds: string[], configuredFallback: string | undefined): string | undefined {
  if (configuredFallback) return configuredFallback;
  return modelIds.find((id) =>
    /^(?:gpt-|o\d|o\d-)/.test(id) &&
    !/(?:embedding|image|audio|tts|transcribe|realtime)/.test(id)
  ) ?? modelIds.find((id) => /^(?:gpt-|o\d|o\d-)/.test(id));
}

function selectEmbeddingModel(modelIds: string[]): string {
  return modelIds.find((id) => id.includes("embedding")) ?? "text-embedding-3-small";
}

function printReport(
  baseUrl: string,
  live: boolean,
  probes: OpenAiEndpointProbe[],
  selectedModels: Record<string, string | undefined>
): void {
  console.log(`OpenAI base URL: ${baseUrl}`);
  console.log(live
    ? "Live probes are enabled. Tiny generation/embedding requests may be billed."
    : "Safe probes only. Add --live to test generation/embedding endpoints with tiny billable requests.");
  if (live) {
    console.log(`Chat model: ${selectedModels.chat ?? "(none selected)"}`);
    console.log(`Responses model: ${selectedModels.responses ?? "(none selected)"}`);
    console.log(`Embedding model: ${selectedModels.embeddings ?? "(none selected)"}`);
  }
  console.log("");
  console.log("Endpoint                 Method  Result         HTTP  Detail");
  console.log("-----------------------  ------  -------------  ----  ------");

  for (const probe of probes) {
    const endpoint = `${probe.path}${probe.live ? " *" : ""}`.padEnd(23);
    const method = probe.method.padEnd(6);
    const status = probe.status.padEnd(13);
    const code = String(probe.statusCode ?? "").padEnd(4);
    console.log(`${endpoint}  ${method}  ${status}  ${code}  ${probe.detail ?? ""}`);
  }

  if (!live) {
    console.log("");
    console.log("* Live endpoints are skipped unless --live is set.");
  }
}

function printHelp(): void {
  console.log(`Usage: npm run openai:endpoints -- [options]

Options:
  --live                         Also test tiny billable POST probes.
  --model <model>                Use one text model for chat and responses probes.
  --chat-model <model>           Use a specific model for /chat/completions.
  --responses-model <model>      Use a specific model for /responses.
  --embedding-model <model>      Use a specific model for /embeddings.
  --json                         Print machine-readable JSON.
  -h, --help                     Show this help.
`);
}
