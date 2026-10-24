import "server-only";
import { timingSafeEqual } from "node:crypto";
import CredentialsProvider from "next-auth/providers/credentials";
import type { NextAuthOptions } from "next-auth";
import { cookies } from "next/headers";
import { z } from "zod";
import { getDatabase } from "@/lib/database";
import { authenticateSession, createMongoAuthStore, digestSessionToken, sessionCookieName } from "./session-core";
import { isBoundAuthToken } from "./auth-binding";

export const AUTH_MAX_AGE_SECONDS = 8 * 60 * 60;

export function authSecretIsReady(): boolean {
  return !!process.env.AUTH_SECRET && Buffer.byteLength(process.env.AUTH_SECRET, "utf8") >= 32;
}

export function authCookieName(production: boolean): string {
  return production ? "__Host-vaultx_auth" : "vaultx_auth";
}

export function configuredOwnerEmail(): string | null {
  const parsed = z.email().safeParse(process.env.AUTH_OWNER_EMAIL?.trim().toLowerCase());
  return parsed.success ? parsed.data : null;
}

export function matchesOwnerEmail(candidate: unknown): boolean {
  const expected = configuredOwnerEmail();
  if (!expected || typeof candidate !== "string") return false;
  const supplied = candidate.trim().toLowerCase();
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  return header?.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

export const authOptions: NextAuthOptions = {
  secret: process.env.AUTH_SECRET,
  session: { strategy: "jwt", maxAge: AUTH_MAX_AGE_SECONDS },
  useSecureCookies: process.env.NODE_ENV === "production",
  cookies: {
    sessionToken: {
      name: authCookieName(process.env.NODE_ENV === "production"),
      options: {
        httpOnly: true, sameSite: "strict", path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
  },
  pages: { signIn: "/unlock", error: "/unlock" },
  providers: [CredentialsProvider({
    id: "vaultx-session",
    name: "VaultX owner session",
    credentials: { email: { label: "Owner email", type: "email" } },
    async authorize(credentials, request) {
      if (!authSecretIsReady()) return null;
      const token = cookieValue(request.headers?.cookie, sessionCookieName(process.env.NODE_ENV === "production"));
      if (!token || !matchesOwnerEmail(credentials?.email)) return null;
      const ownerId = await authenticateSession(createMongoAuthStore(await getDatabase()), token);
      if (!ownerId) return null;
      return { id: ownerId.toHexString(), sessionDigest: digestSessionToken(token), name: "Owner" };
    },
  })],
  callbacks: {
    async jwt({ token, user }) {
      if (user && "sessionDigest" in user && typeof user.sessionDigest === "string") {
        token.ownerId = user.id;
        token.sessionDigest = user.sessionDigest;
      }
      return token;
    },
    async session({ session, token }) {
      if (!authSecretIsReady()) throw new Error("Session unavailable");
      const mongoToken = (await cookies()).get(sessionCookieName(process.env.NODE_ENV === "production"))?.value;
      const ownerId = mongoToken ? await authenticateSession(createMongoAuthStore(await getDatabase()), mongoToken) : null;
      if (!mongoToken || !ownerId || !isBoundAuthToken(token, mongoToken, ownerId.toHexString())) {
        // NextAuth clears its JWT cookie when this callback fails. The MongoDB
        // session remains the authority for lock, expiry and revocation.
        throw new Error("Session unavailable");
      }
      // Never expose the MongoDB session digest or any credential to the browser.
      return { ...session, user: { name: "Owner" } };
    },
  },
  logger: { error() {}, warn() {}, debug() {} },
};
