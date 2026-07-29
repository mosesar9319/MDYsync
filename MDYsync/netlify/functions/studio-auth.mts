import type { Config, Context } from "@netlify/functions";
import {
  createSessionToken,
  expiredSessionCookie,
  readSessionCookie,
  sessionCookie,
  verifyPassword,
  verifySessionToken,
} from "../shared/studio-session.ts";

const SESSION_LENGTH_SECONDS = 8 * 60 * 60;

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export default async (request: Request, _context: Context) => {
  const allowedEmail = (Netlify.env.get("STUDIO_ADMIN_EMAIL") ?? "")
    .trim()
    .toLowerCase();
  const passwordHash = Netlify.env.get("STUDIO_PASSWORD_HASH") ?? "";
  const sessionSecret = Netlify.env.get("STUDIO_SESSION_SECRET") ?? "";

  if (!allowedEmail || !passwordHash || !sessionSecret) {
    return json({ error: "Editor login is not configured." }, 503);
  }

  if (request.method === "GET") {
    const session = await verifySessionToken(
      readSessionCookie(request),
      sessionSecret,
    );
    return json({ authenticated: session?.email === allowedEmail });
  }

  if (request.method === "DELETE") {
    return json(
      { authenticated: false },
      200,
      { "Set-Cookie": expiredSessionCookie() },
    );
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405, { Allow: "GET, POST, DELETE" });
  }

  let email = "";
  let password = "";
  try {
    const body = await request.json() as { email?: unknown; password?: unknown };
    email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return json({ error: "Invalid login request." }, 400);
  }

  const passwordMatches = password.length <= 256
    && await verifyPassword(password, passwordHash);
  if (email !== allowedEmail || !passwordMatches) {
    return json({ error: "The email or password is incorrect." }, 401);
  }

  const expiresAt = Date.now() + SESSION_LENGTH_SECONDS * 1000;
  const token = await createSessionToken(allowedEmail, sessionSecret, expiresAt);
  return json(
    { authenticated: true },
    200,
    { "Set-Cookie": sessionCookie(token, SESSION_LENGTH_SECONDS) },
  );
};

export const config: Config = {
  path: "/api/studio-auth",
};
