import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { DiagramNode } from "./diagramModel";
import { t } from "../../i18n/t";
import { IconClose, IconSearch } from "../icons";

export interface DiagramFinderProps {
  nodes: DiagramNode[];
  query: string;
  onQueryChange: (q: string) => void;
  onSelectNode: (nodeId: string) => void;
  onClose: () => void;
}

export function matchFinderNodes(nodes: DiagramNode[], query: string): DiagramNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return nodes.filter((n) => {
    const labelMatch = n.label?.toLowerCase().includes(q);
    const tagMatch = n.tag ? n.tag.toLowerCase().includes(q) : false;
    const descMatch = n.desc ? n.desc.toLowerCase().includes(q) : false;
    return Boolean(labelMatch || tagMatch || descMatch);
  });
}

export function DiagramFinder({
  nodes,
  query,
  onQueryChange,
  onSelectNode,
  onClose,
}: DiagramFinderProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const results = matchFinderNodes(nodes, query);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }

    if (results.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = results[selectedIndex];
      if (target) {
        onSelectNode(target.id);
      }
    }
  };

  return (
    <div className="diagram-canvas-float diagram-finder" data-testid="diagram-finder">
      <div className="diagram-finder-input-row">
        <IconSearch size={14} className="diagram-finder-search-icon" />
        <input
          ref={inputRef}
          type="text"
          className="diagram-finder-input"
          data-testid="diagram-finder-input"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("editor.diagram_finder_placeholder")}
          aria-label={t("editor.diagram_finder_placeholder")}
        />
        <button
          type="button"
          className="icon-btn icon-btn--sm diagram-finder-close"
          data-testid="diagram-finder-close"
          onClick={onClose}
          aria-label={t("common.close")}
        >
          <IconClose size={14} />
        </button>
      </div>

      {query.trim().length > 0 && (
        <div className="diagram-finder-results" data-testid="diagram-finder-results" role="listbox">
          {results.length === 0 ? (
            <div className="diagram-finder-no-results">
              {t("editor.diagram_finder_no_results")}
            </div>
          ) : (
            results.map((n, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <div
                  key={n.id}
                  className="diagram-finder-item"
                  data-testid={`diagram-finder-item-${n.id}`}
                  data-selected={isSelected ? "true" : undefined}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => onSelectNode(n.id)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <div className="diagram-finder-item-label">{n.label}</div>
                  {n.desc && <div className="diagram-finder-item-desc">{n.desc}</div>}
                  {n.tag && <span className="diagram-finder-item-tag badge" data-tone="accent">{n.tag}</span>}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
