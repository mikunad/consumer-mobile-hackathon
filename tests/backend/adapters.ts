import { vi } from "vitest";

export function syntheticProviders(runId: string) {
  const outbox: { id: string; recipient: string; payload: unknown }[] = [];
  const media = new Map<string, { owner: string; bytes: Uint8Array; type: string }>();
  const verifyOtp = vi.fn(async (_phone: string, _code: string) => ({ approved: false }));
  const startOtp = vi.fn(async (_phone: string) => ({ requestId: `${runId}_otp`, expiresAt: Date.now() + 60_000 }));
  const suggest = vi.fn(async () => ({ suggestions: [] as unknown[] }));
  const sendPush = vi.fn(async (id: string, recipient: string, payload: unknown) => {
    if (!id.startsWith(runId) || !recipient.startsWith("synthetic_")) throw new Error("Nonfixture push target");
    if (!outbox.some((event) => event.id === id)) outbox.push({ id, recipient, payload });
    return { accepted: true };
  });
  const storage = {
    put(owner: string, bytes: Uint8Array, type: string) {
      const id = `${runId}_media_${media.size}`;
      media.set(id, { owner, bytes: bytes.slice(), type });
      return id;
    },
    get(owner: string, id: string) {
      const item = media.get(id);
      if (!item || item.owner !== owner) throw new Error("Media not available");
      return { ...item, bytes: item.bytes.slice() };
    },
    deleteOwner(owner: string) {
      for (const [id, item] of media) if (item.owner === owner) media.delete(id);
    },
  };
  return { startOtp, verifyOtp, suggest, sendPush, storage, outbox };
}
