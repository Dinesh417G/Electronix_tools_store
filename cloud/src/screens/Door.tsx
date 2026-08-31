// The door — §11's `/admin/devices`, on a screen.
//
// The thing this exists to catch is silence. Our software does not open the
// door and never did (§2): the terminal decides on its own and pushes us a
// record afterwards. So when the push stops arriving — device off, network
// moved, ADMS address changed, plant router dropping outbound traffic — the
// door keeps working perfectly and the store simply stops recording who came
// in. Nobody is inconvenienced enough to report it.
//
// `Last heard` is therefore the number on this screen that matters, and it is
// shown as an age rather than a timestamp because "4 days ago" is a judgement
// and "2026-08-23T09:14:02Z" is homework.
//
// Both clocks are shown for a punch. §9.3 says business logic uses
// `received_at`; `device_ts` is diagnostic, and a terminal that has drifted off
// +05:30 shows it here as a gap between the two columns.

// One more thing this screen must never do, learned the hard way on
// 2026-08-31: when the request fails, say so. It used to answer a failed
// `/admin/devices` with `setStatus({ devices: [], … })` and then render that as
// fact — *"No terminal has ever handshaked with this server."* The deployment
// had a device and a punch at the time. That sentence is the worst thing this
// particular screen can get wrong, because it is the screen somebody opens
// precisely to find out whether the door is talking, and it turns "I could not
// ask" into a definite answer that sends them to check the plant's routing.
//
// `useLoadable` keeps loading, failed and empty apart. It already existed and
// nine panels already used it; this one was written before it and never moved.

import type { DoorStatus, PunchRow, adminApi } from "../lib/admin";
import { Banner, Header } from "../components/ui";
import { Loaded, useLoadable } from "./Loadable";

const STALE_MINUTES = 30;

export function Door({
  client,
  onBack,
  onError,
}: {
  client: ReturnType<typeof adminApi>;
  onBack: () => void;
  onError: (m: string) => void;
}) {
  const state = useLoadable<DoorStatus>(() => client.door(), [client], onError);

  return (
    <div className="space-y-4">
      <Header title="Door" subtitle="The reader, and what it has told us" onBack={onBack} />

      <Loaded state={state} label="Asking the door…" empty={null}>
        {(status) => (
          <DoorStatusView status={status} onRefresh={state.reload} />
        )}
      </Loaded>
    </div>
  );
}

function DoorStatusView({
  status,
  onRefresh,
}: {
  status: DoorStatus;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Terminals
        </h2>

        {status.devices.length === 0 && (
          <Banner tone="warn">
            No terminal has ever handshaked with this server. Point the reader&apos;s
            ADMS server address at this address, or the store records nothing at
            the door.
          </Banner>
        )}

        {status.devices.map((device) => {
          const stale = isStale(device.last_seen_at);
          return (
            <div
              key={device.id}
              className={`rounded-xl border-l-4 bg-slate-900 px-4 py-3 ${
                stale ? "border-amber-500" : "border-emerald-500"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="truncate font-semibold">
                  {device.name ?? device.serial_no}
                </span>
                {stale && (
                  <span className="shrink-0 rounded-full border border-amber-600 bg-amber-500/20 px-2 py-0.5 text-xs font-bold text-amber-300">
                    QUIET
                  </span>
                )}
              </div>
              <div className="truncate text-sm text-slate-400">
                {device.serial_no}
                {device.location ? ` · ${device.location}` : ""}
                {device.firmware ? ` · ${device.firmware}` : ""}
              </div>
              <div className="pt-1 text-sm text-slate-300">
                Last heard {ago(device.last_seen_at)}
              </div>
              <div className="text-xs text-slate-500 tabular-nums">
                {device.punch_count} punch{device.punch_count === 1 ? "" : "es"}
                {device.last_punch_at ? ` · last ${ago(device.last_punch_at)}` : ""}
                {device.timezone_offset_min !== null
                  ? ` · device offset ${formatOffset(device.timezone_offset_min)}`
                  : ""}
              </div>
            </div>
          );
        })}
      </section>

      {status.unknown_users.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Unknown at the reader
          </h2>
          <Banner tone="warn">
            These punches arrived for ids that match nobody in the people list.
            They are recorded anyway (§9.4) — somebody opened that door, and the
            history should say so even when it cannot say who. Add the person, or
            correct their terminal user id.
          </Banner>
          {status.unknown_users.map((punch) => (
            <div key={punch.id} className="rounded-xl bg-slate-900 px-4 py-3">
              <div className="font-semibold">id {punch.zk_user_id}</div>
              <div className="text-sm text-slate-400">
                {punch.device_serial} · {ago(punch.received_at)}
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Recent punches
        </h2>
        {status.recent_punches.length === 0 && (
          <p className="py-6 text-center text-slate-500">Nothing yet.</p>
        )}
        {status.recent_punches.map((punch) => (
          <div key={punch.id} className="rounded-xl bg-slate-900 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold">
                {punch.full_name ?? `id ${punch.zk_user_id}`}
              </span>
              {punch.claimed === false && (
                <span className="shrink-0 text-xs text-slate-500">unclaimed</span>
              )}
            </div>
            <div className="text-sm text-slate-400">
              {ago(punch.received_at)}
              {punch.verify_mode ? ` · ${punch.verify_mode.toLowerCase()}` : ""}
            </div>
            {driftSeconds(punch) !== null && Math.abs(driftSeconds(punch)!) > 120 && (
              <div className="pt-1 text-xs text-amber-400">
                The terminal&apos;s clock is {describeDrift(driftSeconds(punch)!)}. Only
                diagnostic — the ledger uses what the server observed.
              </div>
            )}
          </div>
        ))}
      </section>

      <button
        type="button"
        onClick={onRefresh}
        className="tap w-full rounded-xl bg-slate-800 px-4 text-sm text-slate-300"
      >
        Refresh
      </button>
    </div>
  );
}

function isStale(at: string | null): boolean {
  if (!at) return true;
  return Date.now() - Date.parse(at) > STALE_MINUTES * 60_000;
}

function ago(at: string | null): string {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function driftSeconds(punch: PunchRow): number | null {
  if (!punch.device_ts) return null;
  return Math.round((Date.parse(punch.device_ts) - Date.parse(punch.received_at)) / 1000);
}

function describeDrift(seconds: number): string {
  const minutes = Math.round(Math.abs(seconds) / 60);
  const unit = minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} hours`;
  return seconds > 0 ? `${unit} ahead` : `${unit} behind`;
}
