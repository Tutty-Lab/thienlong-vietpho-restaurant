// ============================================================================
// Laden/Speichern des kompletten App-Zustands in der gemeinsamen Datenbank.
// Es wird derselbe JSON-Klumpen abgelegt wie im LocalStorage – dadurch bleibt
// das Datenmodell unverändert und LocalStorage funktioniert weiter als
// Offline-Puffer, falls das Netz weg ist. Getrennt wird je Filiale (store_id).
// ============================================================================

import type { PersistedState } from "./storage";
import { isRemoteConfigured, supabase } from "./supabase";

const TABLE = "store_data";

export type RemoteStatus = "off" | "idle" | "saving" | "error";

/** Zustand einer Filiale holen. null = für diese Filiale noch keine Zeile. */
export async function loadRemote(storeId: string): Promise<PersistedState | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select("data")
    .eq("store_id", storeId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data?.data as PersistedState | undefined) ?? null;
}

/** Zustand einer Filiale schreiben (anlegen oder überschreiben). */
export async function saveRemote(storeId: string, state: PersistedState): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase
    .from(TABLE)
    .upsert({ store_id: storeId, data: state }, { onConflict: "store_id" });

  if (error) throw new Error(error.message);
}

export { isRemoteConfigured };
