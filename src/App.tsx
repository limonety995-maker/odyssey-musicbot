import { useEffect, useState } from "react";
import OBR from "@owlbear-rodeo/sdk";
import { useLibraryStore } from "./hooks/useLibraryStore";
import { LibraryTree } from "./components/LibraryTree";
import { PlaylistInspector } from "./components/PlaylistInspector";

import sprite from "./sprite//sprite.svg";

export function App() {
  const {
    library,
    selectedId,
    selectedNode,
    expandedIds,
    toggleFolder,
    selectNode,
    createFolder,
    createPlaylist,
    getNode,
    getSelectedFolderId,
    getTrackCount,
    getTracksForPlaylist,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
  } = useLibraryStore();

  return (
    <div className="container">
      <nav className="navigation">
        <div className="header-container">
          <svg width="16" height="16" className="icon">
            <use href={`${sprite}#icon-folderempty`}></use>
          </svg>
          <p>Main</p>
        </div>
        <button className="icon-button">
          <svg width="16" height="16" className="icon">
            <use href={`${sprite}#icon-edit`}></use>
          </svg>
        </button>
      </nav>

      <section className="content-container">
        <button
          className="icon-button folder"
          type="button"
          onClick={() => {
            const name = window.prompt("Folder name", "New folder");
            if (!name) {
              return;
            }
            createFolder(getSelectedFolderId(), name);
          }}
        >
          <svg width="72" height="92" className="icon">
            <use href={`${sprite}#icon-addfolder`}></use>
          </svg>
          New folder
        </button>
      </section>

      <footer className="audioplayer-container">
        <div className="song-name-container">
          <button className="icon-button">
            <svg width="16" height="16" className="icon">
              <use href={`${sprite}#icon-down`}></use>
            </svg>
          </button>
          <svg height="28" width="28" className="icon disk-playing">
            <use href={`${sprite}#icon-Subtract`}></use>
          </svg>
          <p>Song name</p>
        </div>
        <div className="play-bar">
          <button className="icon-button">
            <svg width="16" height="16" className="icon">
              <use href={`${sprite}#icon-play`}></use>
            </svg>
          </button>
          <button className="icon-button">
            <svg width="16" height="16" className="icon">
              <use href={`${sprite}#icon-stop`}></use>
            </svg>
          </button>
        </div>
      </footer>
    </div>
  );
}
