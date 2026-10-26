import { SidebarChat } from "../components/leftpanel/SidebarChat";

interface MobileChatViewProps {
  onOpenNote: (id: string) => void;
}

/**
 * `chat` mode on the phone (AI chat opened to /app on 2026-10-06 — owner decision, personal app;
 * specs/commands/pet.yaml http:true for the chat core). One implementation: the desktop
 * SidebarChat itself, hosted in a flex column that fills the list area (it was built for a ~320px
 * sidebar; the phone is 384px CSS wide, so it fits as is). A separate phone chat would duplicate
 * the send pipeline, session tools, failure handling and history merge — the thin wrapper only
 * (1) gives it the height contract (flex 1 / min-height 0 so the composer pins to the bottom and
 * the list scrolls) and (2) routes note-chip taps to the phone's own navigation via `onOpenNote`.
 *
 * Keyboard: MobileApp hides the tab bar while the keyboard is open (useKeyboardOpen), the
 * container then regrows and the composer stays at the bottom edge of the visual viewport.
 * Failures: SidebarChat shows an inline reason + Retry row and records the category to the
 * diagnostics sink (lib/chatFailure.ts, reportFallback "chat/send_failed_*").
 *
 * `.mobile-chat` is the CSS hook for touch-target sizing of the composer/toolbar buttons.
 */
export function MobileChatView({ onOpenNote }: MobileChatViewProps) {
  return (
    <div
      className="mobile-chat"
      data-testid="mobile-chat"
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <SidebarChat onOpenNote={onOpenNote} />
    </div>
  );
}
