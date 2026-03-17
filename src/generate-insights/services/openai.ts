import OpenAI from "openai";
import { config } from "./config";

export const openai = new OpenAI({
  apiKey: config.openaiApiKey,
});

export const OPENAI_MODEL = config.openaiModel;
