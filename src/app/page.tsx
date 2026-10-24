import { redirect } from "next/navigation";
import { lockCurrentSession } from "@/lib/auth/server";

export default async function Home() {
  await lockCurrentSession();
  redirect("/unlock");
}
