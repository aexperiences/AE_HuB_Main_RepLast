import { Router, type IRouter } from "express";
import { requireEmployeeAuth } from "../middlewares/authMiddleware";
import { openai } from "@workspace/integrations-openai-ai-server";
import { z } from "zod";

const router: IRouter = Router();

const ALLOWED_SIZES = ["1024x1024", "1792x1024", "1024x1792"] as const;

const GenerateBody = z.object({
  prompt: z.string().min(1).max(4000),
  size: z.enum(ALLOWED_SIZES).default("1024x1024"),
  quality: z.enum(["standard", "hd"]).default("hd"),
  style: z.enum(["vivid", "natural"]).default("vivid"),
});

const VariationBody = z.object({
  prompt: z.string().min(1).max(4000),
  size: z.enum(ALLOWED_SIZES).default("1024x1024"),
  quality: z.enum(["standard", "hd"]).default("hd"),
  style: z.enum(["vivid", "natural"]).default("vivid"),
  seed: z.number().int().optional(),
});

router.post("/image/generate", requireEmployeeAuth, async (req, res): Promise<void> => {
  const parsed = GenerateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { prompt, size, quality, style } = parsed.data;

  try {
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt,
      n: 1,
      size,
      quality,
      style,
      response_format: "url",
    });

    const url = response.data?.[0]?.url;
    const revisedPrompt = response.data?.[0]?.revised_prompt;

    if (!url) {
      res.status(500).json({ error: "No image URL returned" });
      return;
    }

    res.json({ url, revisedPrompt, prompt, size, quality });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Image generation failed";
    res.status(500).json({ error: message });
  }
});

router.post("/image/generate-batch", requireEmployeeAuth, async (req, res): Promise<void> => {
  const BatchBody = z.object({
    prompts: z.array(z.string().min(1).max(4000)).min(1).max(4),
    size: z.enum(ALLOWED_SIZES).default("1024x1024"),
    quality: z.enum(["standard", "hd"]).default("standard"),
    style: z.enum(["vivid", "natural"]).default("vivid"),
  });

  const parsed = BatchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { prompts, size, quality, style } = parsed.data;

  try {
    const results = await Promise.allSettled(
      prompts.map(prompt =>
        openai.images.generate({
          model: "dall-e-3",
          prompt,
          n: 1,
          size,
          quality,
          style,
          response_format: "url",
        })
      )
    );

    const images = results.map((r, i) => {
      if (r.status === "fulfilled") {
        return {
          url: r.value.data?.[0]?.url ?? null,
          revisedPrompt: r.value.data?.[0]?.revised_prompt ?? null,
          prompt: prompts[i],
          error: null,
        };
      }
      return {
        url: null,
        revisedPrompt: null,
        prompt: prompts[i],
        error: r.reason instanceof Error ? r.reason.message : "Failed",
      };
    });

    res.json({ images, size, quality });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Batch generation failed";
    res.status(500).json({ error: message });
  }
});

export default router;
