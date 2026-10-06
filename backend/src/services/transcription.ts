import { env } from "../config/env";

export async function transcribeAudioBuffer(
  audioBuffer: Buffer,
  mimeType = "audio/ogg"
): Promise<string | null> {
  if (!env.OPENAI_API_KEY) {
    console.log("[Whisper Mock] OPENAI_API_KEY não configurada — pulando transcrição de áudio");
    return null;
  }

  try {
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: mimeType });
    formData.append("file", blob, "audio.ogg");
    formData.append("model", "whisper-1");
    formData.append("language", "pt");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn("Falha no Whisper API:", res.status, err);
      return null;
    }

    const data = (await res.json()) as { text?: string };
    return data.text?.trim() || null;
  } catch (error) {
    console.error("Erro ao transcrever áudio com Whisper:", error);
    return null;
  }
}
