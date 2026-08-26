// Label printer settings.
//
// The honest part of this screen is `mode`. A browser cannot open a raw socket
// to a printer, and a serverless function in Vercel's cloud has no route to a
// private LAN address — so an IP typed here does nothing on its own. Rather
// than offer a field that silently has no effect, the screen says which of the
// two arrangements is live and what each one needs.

import { useCallback, useEffect, useState } from "react";
import { ApiError, OfflineError } from "../lib/api";
import type { adminApi, PrinterSettings as Settings } from "../lib/admin";
import { BigButton, Banner, Field, Spinner } from "../components/ui";

interface Props {
  client: ReturnType<typeof adminApi>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}

const DPI_OPTIONS = [203, 300, 600] as const;

export function PrinterSettings({ client, onNotice, onError }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    client
      .printerSettings()
      .then(setSettings)
      .catch((err) => onError(describe(err)));
  }, [client, onError]);

  useEffect(load, [load]);

  if (!settings) {
    return (
      <div className="flex justify-center py-12">
        <Spinner label="Loading printer settings" />
      </div>
    );
  }

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((s) => (s ? { ...s, [key]: value } : s));

  const save = async () => {
    setSaving(true);
    try {
      const saved = await client.savePrinterSettings(settings);
      setSettings(saved);
      onNotice("Printer settings saved.");
    } catch (err) {
      onError(describe(err));
    } finally {
      setSaving(false);
    }
  };

  const lan = settings.mode === "LAN_AGENT";

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          How labels reach paper
        </h3>

        <ModeCard
          selected={!lan}
          onSelect={() => set("mode", "BROWSER_PDF")}
          title="Print from this browser"
          detail="The label opens in a new tab and prints through the normal print
                  dialogue. Works on any device with any printer. Needs somebody to tap
                  print."
        />

        <ModeCard
          selected={lan}
          onSelect={() => set("mode", "LAN_AGENT")}
          title="Send to a printer on the shop network"
          detail="Unattended: jobs queue here and a small agent inside the plant sends
                  them to the printer. The agent has to be running — nothing in the
                  cloud can reach a private address on its own."
        />
      </section>

      {lan && (
        <Banner tone="info">
          Jobs will queue until the shop-floor agent picks them up. Until it is
          installed, nothing will print — switch back to browser printing if you need
          a label today.
        </Banner>
      )}

      <section className="space-y-3">
        <Field label="Printer name" hint="Only a label for this screen.">
          <input
            value={settings.name ?? ""}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Zebra by the door"
            className="tap w-full rounded-xl bg-slate-800 px-4 text-base"
          />
        </Field>

        {lan && (
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Field label="IP address or hostname">
                <input
                  value={settings.host ?? ""}
                  onChange={(e) => set("host", e.target.value)}
                  placeholder="192.168.0.50"
                  inputMode="decimal"
                  className="tap w-full rounded-xl bg-slate-800 px-4 text-base"
                />
              </Field>
            </div>
            <Field label="Port">
              <input
                value={String(settings.port)}
                onChange={(e) => set("port", Number(e.target.value) || 9100)}
                inputMode="numeric"
                className="tap w-full rounded-xl bg-slate-800 px-4 text-base"
              />
            </Field>
          </div>
        )}

        <Field label="Resolution" hint="203 dpi is the usual thermal label printer.">
          <div className="flex gap-2">
            {DPI_OPTIONS.map((dpi) => (
              <button
                key={dpi}
                type="button"
                onClick={() => set("dpi", dpi)}
                className={`tap flex-1 rounded-xl text-sm font-semibold ${
                  settings.dpi === dpi ? "bg-sky-600" : "bg-slate-800 text-slate-300"
                }`}
              >
                {dpi}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Label width (mm)">
            <input
              value={settings.label_width_mm}
              onChange={(e) => set("label_width_mm", e.target.value)}
              inputMode="decimal"
              className="tap w-full rounded-xl bg-slate-800 px-4 text-base"
            />
          </Field>
          <Field label="Label height (mm)">
            <input
              value={settings.label_height_mm}
              onChange={(e) => set("label_height_mm", e.target.value)}
              inputMode="decimal"
              className="tap w-full rounded-xl bg-slate-800 px-4 text-base"
            />
          </Field>
        </div>
      </section>

      <BigButton onClick={save} variant="primary" className="w-full" disabled={saving}>
        {saving ? "Saving…" : "Save settings"}
      </BigButton>

      <p className="pt-1 text-xs text-slate-500">
        Print one label and scan it before printing a roll. Toner spread and printer
        calibration are the two things no amount of testing here can predict.
      </p>
    </div>
  );
}

function ModeCard({
  selected,
  onSelect,
  title,
  detail,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-2xl border p-4 text-left ${
        selected ? "border-sky-500 bg-slate-800" : "border-slate-700 bg-slate-900"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-1 h-4 w-4 shrink-0 rounded-full border-2 ${
            selected ? "border-sky-400 bg-sky-400" : "border-slate-500"
          }`}
        />
        <span>
          <span className="block text-sm font-semibold">{title}</span>
          <span className="block pt-1 text-xs leading-relaxed text-slate-400">{detail}</span>
        </span>
      </div>
    </button>
  );
}

function describe(err: unknown): string {
  if (err instanceof OfflineError) return "The server is not reachable.";
  if (err instanceof ApiError) return err.message;
  return "Something went wrong.";
}
