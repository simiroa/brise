/** Pet IPC channel names — one map so a rename cannot silently desync emit/listen. */
export const PET_EVENT = {
  openNote: "pet-open-note",
  actionNewNote: "pet-action-new-note",
  enabledChanged: "pet-enabled-changed",
  themeChanged: "pet-theme-changed",
  bubbleClosed: "pet-bubble-closed",
  suggestionsPending: "pet-suggestions-pending",
  signal: "pet-signal",
  clipboardSave: "pet-clipboard-save",
  screenshotCapture: "pet-screenshot-capture",
  packagesChanged: "pet-packages-changed",
  assetsChanged: "pet-assets-changed",
  bubblePayload: "pet-bubble-payload",
  bubbleCloseRequest: "pet-bubble-close-request",
  suggestionsRefresh: "pet-suggestions-refresh",
  suggestionDismiss: "pet-suggestion-dismiss",
  reviewSuggestion: "pet-review-suggestion",
  acceptLinkSuggestion: "pet-accept-link-suggestion",
  acceptThemeSuggestion: "pet-accept-theme-suggestion",
  acceptCollectSuggestion: "pet-accept-collect-suggestion",
  screenshotAccept: "pet-screenshot-accept",
  clipboardAccept: "pet-clipboard-accept",
  chatUpdated: "pet-chat-updated",
  reviewChatPlan: "pet-review-chat-plan",
  applyChatSection: "pet-apply-chat-section",
} as const;

export type PetEventName = (typeof PET_EVENT)[keyof typeof PET_EVENT];
