import { redirect } from "@tanstack/react-router";
import { deleteCookie, getCookie, getRequestUrl, setCookie } from "@tanstack/react-start/server";
import { type User, createSession, endSession, sessionUser } from "#/db/users";
import { database } from "./env";

const COOKIE = "ps_session";

export async function viewer(): Promise<User | null> {
  const token = getCookie(COOKIE);
  return token ? sessionUser(database(), token) : null;
}

/** For a signed-in page or action: no session sends the browser to sign in. */
export async function requireViewer(): Promise<User> {
  const user = await viewer();
  if (!user) throw redirect({ to: "/" });
  return user;
}

export async function startSession(userId: string): Promise<void> {
  setCookie(COOKIE, await createSession(database(), userId), {
    httpOnly: true,
    secure: getRequestUrl().protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
}

export async function stopSession(): Promise<void> {
  const token = getCookie(COOKIE);
  if (token) await endSession(database(), token);
  deleteCookie(COOKIE, { path: "/" });
}
