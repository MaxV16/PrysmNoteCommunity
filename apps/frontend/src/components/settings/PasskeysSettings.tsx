"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { isWebAuthnSupported, passkeysApi, registerPasskey, type PasskeySummary } from "@/lib/webauthn";

function deviceHint(passkey: PasskeySummary): string {
  if (passkey.transports?.includes("internal")) return "Built-in authenticator";
  if (passkey.transports?.includes("hybrid")) return "Phone or tablet";
  if (passkey.transports?.includes("usb")) return "Security key (USB)";
  if (passkey.transports?.includes("nfc")) return "Security key (NFC)";
  return "Passkey";
}

/**
 * Passkeys settings (core feature): add, rename and remove WebAuthn
 * credentials for the signed-in account. Used in Settings > Account > Security.
 */
export function PasskeysSettings() {
  const [supported, setSupported] = useState(false);
  const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [removeId, setRemoveId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setPasskeys(await passkeysApi.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your passkeys.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setSupported(isWebAuthnSupported());
    void load();
  }, [load]);

  const handleAdd = async () => {
    setAdding(true);
    setError("");
    try {
      await registerPasskey(newName || undefined);
      setAddOpen(false);
      setNewName("");
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (/cancel|abort|not allowed/i.test(msg)) {
        setError("Passkey setup was cancelled.");
      } else {
        setError(msg || "Could not add this passkey.");
      }
    } finally {
      setAdding(false);
    }
  };

  const handleRename = async (id: string) => {
    const name = renameName.trim();
    if (!name) return;
    setBusyId(id);
    setError("");
    try {
      await passkeysApi.rename(id, name);
      setRenameId(null);
      setRenameName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename this passkey.");
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async () => {
    if (!removeId) return;
    setBusyId(removeId);
    setError("");
    try {
      await passkeysApi.remove(removeId);
      setRemoveId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove this passkey.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-secondary">Passkeys</p>
          <p className="text-xs text-muted">
            Sign in with Touch ID, Face ID, Windows Hello or a security key instead of a password.
          </p>
        </div>
        {supported && (
          <button
            onClick={() => { setNewName(""); setAddOpen(true); }}
            className="btn btn-gradient shrink-0 px-4 py-1.5 text-xs rounded-xl"
          >
            Add a passkey
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg bg-danger/10 px-4 py-2.5 text-sm text-danger">{error}</div>
      )}

      {!supported ? (
        <p className="rounded-xl bg-elevated px-4 py-3 text-xs text-muted border border-border">
          This browser does not support passkeys. Try Safari, Chrome or Edge on a device with a
          screen lock, or a hardware security key.
        </p>
      ) : loading ? (
        <p className="rounded-xl bg-elevated px-4 py-3 text-xs text-muted border border-border">Loading...</p>
      ) : passkeys.length === 0 ? (
        <p className="rounded-xl bg-elevated px-4 py-3 text-xs text-muted border border-border">
          No passkeys yet. Add one to sign in faster next time.
        </p>
      ) : (
        <div className="space-y-2">
          {passkeys.map((pk) => (
            <div key={pk.id} className="flex items-center justify-between gap-3 rounded-xl bg-elevated px-4 py-3 border border-border">
              <div className="min-w-0">
                {renameId === pk.id ? (
                  <input
                    autoFocus
                    value={renameName}
                    onChange={(e) => setRenameName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void handleRename(pk.id); if (e.key === "Escape") setRenameId(null); }}
                    maxLength={100}
                    className="input-field"
                    placeholder="Passkey name"
                  />
                ) : (
                  <>
                    <p className="truncate text-sm text-secondary">{pk.name || "Unnamed passkey"}</p>
                    <p className="text-xs text-muted">
                      {deviceHint(pk)}
                      {pk.last_used_at ? ` - last used ${new Date(pk.last_used_at).toLocaleDateString()}` : " - not used yet"}
                    </p>
                  </>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {renameId === pk.id ? (
                  <>
                    <button
                      onClick={() => void handleRename(pk.id)}
                      disabled={busyId === pk.id || !renameName.trim()}
                      className="btn btn-primary px-3 py-1.5 text-xs rounded-xl disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setRenameId(null)}
                      className="btn bg-elevated border border-border px-3 py-1.5 text-xs rounded-xl text-secondary hover:text-primary"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => { setRenameId(pk.id); setRenameName(pk.name || ""); }}
                      className="btn bg-elevated border border-border px-3 py-1.5 text-xs rounded-xl text-secondary hover:text-primary"
                    >
                      Rename
                    </button>
                    <button
                      onClick={() => setRemoveId(pk.id)}
                      className="btn px-3 py-1.5 text-xs rounded-xl text-danger hover:bg-hover"
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal isOpen={addOpen} onClose={() => !adding && setAddOpen(false)} title="Add a passkey">
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-secondary">Name (optional)</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={100}
              className="input-field"
              placeholder="e.g. MacBook Touch ID"
            />
          </div>
          <p className="text-xs text-muted">
            Your device will ask for Touch ID, Face ID, Windows Hello or a security key to create the
            passkey.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => void handleAdd()}
              disabled={adding}
              className="btn btn-primary flex-1 px-4 py-2 text-sm disabled:opacity-50"
            >
              {adding ? "Waiting for device..." : "Create passkey"}
            </button>
            <button
              onClick={() => setAddOpen(false)}
              disabled={adding}
              className="btn bg-elevated border border-border px-4 py-2 text-sm rounded-xl text-secondary disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!removeId} onClose={() => !busyId && setRemoveId(null)} title="Remove passkey">
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            Removing this passkey means you can no longer sign in with it. Your other sign-in methods
            stay the same.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => void handleRemove()}
              disabled={!!busyId}
              className="btn flex-1 px-4 py-2 text-sm rounded-xl bg-danger text-[var(--on-gradient)] disabled:opacity-50"
            >
              {busyId ? "Removing..." : "Remove passkey"}
            </button>
            <button
              onClick={() => setRemoveId(null)}
              disabled={!!busyId}
              className="btn bg-elevated border border-border px-4 py-2 text-sm rounded-xl text-secondary disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
