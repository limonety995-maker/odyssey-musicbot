import OBR from "@owlbear-rodeo/sdk";

const statusElement = document.getElementById("background-status");

function setStatus(message: string) {
  if (statusElement) {
    statusElement.textContent = message;
  }
}

OBR.onReady(() => {
  setStatus("Background engine ready for the React rewrite.");
});
