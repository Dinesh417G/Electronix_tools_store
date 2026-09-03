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
import { Row, RowList } from "../components/row";
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
        <h2 className="text-xs font-semibold uppercase tracking-wide text-faint">
          Terminals
        </h2>

        {status.devices.length === 0 && (
          <Banner tone="warn">
            No terminal has ever handshaked with this server. Point the reader&apos;s
            ADMS server address at this address, or the store records nothing at
            the door.
          </Banner>
        )}

        {status.devices.length > 0 && (
          <RowList>
            {status.devices.map((device) => {
              const stale = isStale(device.last_seen_at);
              return (
                <div key={device.id} className={`border-l-2 ${stale ? "border-warning" : "border-success"}`}>
                  <Row
                    title={device.name ?? device.serial_no}
                    badge={
                      stale && (
                        <span className="shrink-0 rounded-full border border-warning-line bg-warning-soft px-2 py-0.5 text-xs font-bold text-warning">
                          QUIET
                        </span>
                      )
                    }
                    subtitle={
                      device.serial_no +
                      (device.location ? ` · ${device.location}` : "") +
                      (device.firmware ? ` · ${device.firmware}` : "")
                    }
                    meta={
                      `${device.punch_count} punch${device.punch_count === 1 ? "" : "es"}` +
                      (device.last_punch_at ? ` · last ${ago(device.last_punch_at)}` : "") +
                      (device.timezone_offset_min !== null
                        ? ` · device offset ${formatOffset(device.timezone_offset_min)}`
                        : "")
                    }
                    value={ago(device.last_seen_at)}
                    valueNote="last heard"
                    tone={stale ? "low" : "plain"}
                  />
                </div>
              );
            })}
          </RowList>
        )}
      </section>

      {status.unknown_users.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-faint">
            Unknown at the reader
          </h2>
          <Banner tone="warn">
            These punches arrived for ids that match nobody in the people list.
            They are recorded anyway (§9.4) — somebody opened that door, and the
            history should say so even when it cannot say who. Add the person, or
            correct their terminal user id.
          </Banner>
          <RowList>
            {status.unknown_users.map((punch) => (
              <Row
                key={punch.id}
                title={`id ${punch.zk_user_id}`}
                subtitle={`${punch.device_serial} · ${ago(punch.received_at)}`}
              />
            ))}
          </RowList>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-faint">
          Recent punches
        </h2>
        {status.recent_punches.length === 0 && (
          <p className="py-6 text-center text-faint">Nothing yet.</p>
        )}
        {status.recent_punches.length > 0 && (
          <RowList>
            {status.recent_punches.map((punch) => {
              const drift = driftSeconds(punch);
              const drifted = drift !== null && Math.abs(drift) > 120;
              return (
                <Row
                  key={punch.id}
                  title={punch.full_name ?? `id ${punch.zk_user_id}`}
                  badge={
                    punch.claimed === false && (
                      <span className="shrink-0 text-xs text-faint">unclaimed</span>
                    )
                  }
                  subtitle={
                    ago(punch.received_at) +
                    (punch.verify_mode ? ` · ${punch.verify_mode.toLowerCase()}` : "")
                  }
                  meta={
                    drifted ? (
                      <span className="text-warning">
                        clock {describeDrift(drift!)} — diagnostic only
                      </span>
                    ) : undefined
                  }
                />
              );
            })}
          </RowList>
        )}
      </section>

      <button
        type="button"
        onClick={onRefresh}
        className="tap w-full rounded-xl bg-surface-2 px-4 text-sm text-ink-2"
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
