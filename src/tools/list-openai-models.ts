import { loadConfig } from "../core/config.js";
import { listOpenAiModels } from "../providers/openai.js";

try {
  const config = loadConfig();
  const models = await listOpenAiModels(config);

  if (models.length === 0) {
    console.log("No OpenAI models were returned for this API key.");
    process.exit(0);
  }

  for (const model of models) {
    const owner = model.ownedBy ? `\t${model.ownedBy}` : "";
    console.log(`${model.id}${owner}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed to list OpenAI models");
  process.exitCode = 1;
}
