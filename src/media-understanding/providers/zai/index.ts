import type { MediaUnderstandingProvider } from "../../types.js";
import { transcribeZaiAudio } from "./audio.js";

export const zaiProvider: MediaUnderstandingProvider = {
  id: "zai",
  capabilities: ["audio"],
  transcribeAudio: transcribeZaiAudio,
};
