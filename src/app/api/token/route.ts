import { handle } from "@/lib/api";
import { getTemporaryToken } from "@/lib/assemblyai/token";

export const dynamic = "force-dynamic";

export const GET = handle(async () => {
  const token = await getTemporaryToken(300);
  return Response.json({ token });
});
