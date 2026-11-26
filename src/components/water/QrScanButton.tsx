import { ScanLine } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { errorMessage } from "@/lib/errors";
import { isNativeApp } from "@/lib/native";

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type DetectorCtor = new (opts: { formats: string[] }) => Detector;
const BrowserDetector = (globalThis as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;

/** Scan a QR code: Google's scanner in the Android app, camera + BarcodeDetector in browsers. */
export function QrScanButton({ onResult, label = "Scan QR code" }: { onResult: (text: string) => void; label?: string }) {
  const [webOpen, setWebOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  if (!isNativeApp && !BrowserDetector) return null;

  async function scanNative() {
    setBusy(true);
    try {
      const { BarcodeScanner, BarcodeFormat } = await import("@capacitor-mlkit/barcode-scanning");
      const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
      if (!available) {
        toast("Preparing the scanner… this happens only once.");
        await BarcodeScanner.installGoogleBarcodeScannerModule();
      }
      const { barcodes } = await BarcodeScanner.scan({ formats: [BarcodeFormat.QrCode] });
      const value = barcodes[0]?.rawValue;
      if (value) onResult(value);
    } catch (e) {
      const msg = errorMessage(e);
      if (!/cancel/i.test(msg)) toast.error(msg.includes("not available") ? "Scanner is downloading. Try again in a moment." : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" variant="outline" className="w-full" loading={busy} onClick={() => (isNativeApp ? scanNative() : setWebOpen(true))}>
        <ScanLine /> {label}
      </Button>
      {webOpen && <WebScanner onClose={() => setWebOpen(false)} onResult={(t) => { setWebOpen(false); onResult(t); }} />}
    </>
  );
}

function WebScanner({ onClose, onResult }: { onClose: () => void; onResult: (text: string) => void }) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const detector = new BrowserDetector!({ formats: ["qr_code"] });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        const tick = async () => {
          if (stopped || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            if (codes[0]?.rawValue) return onResult(codes[0].rawValue);
          } catch {
            /* frame not ready */
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        setError("Camera permission is needed to scan. You can type the supplier code instead.");
      }
    })();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent title="Scan supplier QR code" description="Point the camera at the QR code your supplier shared.">
        {error ? <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{error}</p> : (
          <div className="relative overflow-hidden rounded-xl bg-black">
            <video ref={videoRef} className="aspect-square w-full object-cover" muted playsInline />
            <div className="pointer-events-none absolute inset-8 rounded-2xl border-4 border-white/80" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
