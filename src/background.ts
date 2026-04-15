import OBR from "@owlbear-rodeo/sdk";

const statusElement = document.getElementById("background-status");
const GM_POPOVER_WIDTH = 585;
const GM_POPOVER_HEIGHT = 400;
const PLAYER_POPOVER_WIDTH = 585;
const PLAYER_POPOVER_HEIGHT = 52;

function setStatus(message: string) {
  if (statusElement) {
    statusElement.textContent = message;
  }
}

OBR.onReady(() => {
  const applyActionSize = async () => {
    const role = await OBR.player.getRole();
    const isGm = role === "GM";
    const width = isGm ? GM_POPOVER_WIDTH : PLAYER_POPOVER_WIDTH;
    const height = isGm ? GM_POPOVER_HEIGHT : PLAYER_POPOVER_HEIGHT;
    await OBR.action.setWidth(width);
    await OBR.action.setHeight(height);
    setStatus(`Background ready (${role})`);
  };

  void applyActionSize();
  OBR.action.onOpenChange((isOpen) => {
    if (isOpen) {
      void applyActionSize();
    }
  });
  OBR.player.onChange(() => {
    void applyActionSize();
  });
});
