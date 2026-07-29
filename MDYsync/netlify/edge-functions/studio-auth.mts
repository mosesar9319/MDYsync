import type { Config, Context } from "@netlify/edge-functions";
import {
  readSessionCookie,
  verifySessionToken,
} from "../shared/studio-session.ts";

export default async (request: Request, context: Context) => {
  const allowedEmail = (Netlify.env.get("STUDIO_ADMIN_EMAIL") ?? "")
    .trim()
    .toLowerCase();
  const sessionSecret = Netlify.env.get("STUDIO_SESSION_SECRET") ?? "";
  const session = await verifySessionToken(
    readSessionCookie(request),
    sessionSecret,
  );

  if (!allowedEmail || session?.email !== allowedEmail) {
    if (new URL(request.url).pathname.startsWith("/api/")) {
      return Response.json(
        { error: "Editor login required." },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.redirect(new URL("/?editor=login", request.url), 302);
  }

  return context.next();
};

export const config: Config = {
  path: [
    "/studio",
    "/studio/*",
    "/api/publish-alignment",
    "/api/save-video-link",
    "/api/trigger-ocr-job",
    "/api/trigger-page-ocr-job",
    "/api/youtube-channel-sync",
  ],
};
