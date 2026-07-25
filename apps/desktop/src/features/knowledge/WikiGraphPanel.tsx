import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { buildWikiGraphFallbackEdges, buildWikiGraphLayout, wikiBasename } from '../../domains/knowledge/knowledge';
import { arr, text, WIKI_GROUP_COLORS as colors } from './knowledgePresentation';

type Item = Record<string, unknown>;

type WikiGraphPanelProps = {
  graph: Item;
  notes: Item[];
  activePath: string;
  focusMode: boolean;
  onFocusModeChange: (value: boolean) => void;
  onOpenDocument: (path: string, intent: 'select' | 'open') => void;
  children: ReactNode;
};

export function WikiGraphPanel({ graph, notes: list, activePath, focusMode: graphFocusMode, onFocusModeChange, onOpenDocument, children }: WikiGraphPanelProps) {
  const [graphZoom, setGraphZoom] = useState(1);
  const [graphPan, setGraphPan] = useState({ x: 0, y: 0 });
  const [graphPanning, setGraphPanning] = useState(false);
  const [graphSettingsOpen, setGraphSettingsOpen] = useState(false);
  const [graphTimelapseActive, setGraphTimelapseActive] = useState(false);
  const [graphShowLabels, setGraphShowLabels] = useState(true);
  const [graphNodeScale, setGraphNodeScale] = useState(1);
  const [graphLinkScale, setGraphLinkScale] = useState(1);
  const [graphLinkOpacity, setGraphLinkOpacity] = useState(.62);
  const [graphCenterForce, setGraphCenterForce] = useState(1);
  const [graphRepelForce, setGraphRepelForce] = useState(1);
  const [graphLinkDistance, setGraphLinkDistance] = useState(1);
  const [graphFilterQuery, setGraphFilterQuery] = useState('');
  const [graphShowOrphans, setGraphShowOrphans] = useState(true);
  const [graphLocalMode, setGraphLocalMode] = useState(false);
  const [graphBannerInteractive, setGraphBannerInteractive] = useState(false);
  const [hoveredGraphId, setHoveredGraphId] = useState('');
  const [draggedGraphPositions, setDraggedGraphPositions] = useState<Record<string, { x: number; y: number }>>({});
  const graphCanvasRef = useRef<HTMLDivElement | null>(null);
  const graphDragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const graphNodeDragRef = useRef<{ id: string; x: number; y: number; nodeX: number; nodeY: number; moved: boolean } | null>(null);
  const lastGraphClickRef = useRef<{ id: string; at: number } | null>(null);
  const suppressGraphClickRef = useRef(false);
  const graphNodesRaw = arr(graph, 'nodes');
  const graphEdgesRaw = arr(graph, 'edges');
  const graphEdges = useMemo(() => graphEdgesRaw.length ? graphEdgesRaw : buildWikiGraphFallbackEdges(list), [graphEdgesRaw, list]);
  const graphLayout = useMemo(() => buildWikiGraphLayout(graphNodesRaw, list, graphEdges, {
    centerForce: graphCenterForce,
    repelForce: graphRepelForce,
    linkDistance: graphLinkDistance,
  }), [graphNodesRaw, list, graphEdges, graphCenterForce, graphRepelForce, graphLinkDistance]);
  const graphGroups = (Array.isArray(graph.groups) ? graph.groups.map(String) : graphLayout.groups).slice(0, 8);
  const graphNodes = graphLayout.nodes.map((entry) => {
    const draggedPosition = draggedGraphPositions[entry.id];
    return draggedPosition ? { ...entry, x: draggedPosition.x, y: draggedPosition.y } : entry;
  });
  const graphLayoutEdges = graphLayout.edges;
  const activeGraphId = activePath;
  const activeLocalGraphIds = new Set<string>();
  if (activeGraphId) {
    activeLocalGraphIds.add(activeGraphId);
    graphLayoutEdges.forEach((edge) => {
      const from = text(edge.from);
      const to = text(edge.to);
      if (from === activeGraphId) activeLocalGraphIds.add(to);
      if (to === activeGraphId) activeLocalGraphIds.add(from);
    });
  }
  const localGraphHasActive = Boolean(activeGraphId && graphNodes.some((entry) => entry.id === activeGraphId));
  const localGraphScopeActive = graphLocalMode && localGraphHasActive;
  const localGraphCenter = { x: 480, y: 310 };
  const localGraphNodeOrder = new Map(
    graphNodes
      .filter((entry) => activeLocalGraphIds.has(entry.id) && entry.id !== activeGraphId)
      .sort((left, right) => right.linkCount - left.linkCount || left.label.localeCompare(right.label))
      .map((entry, index) => [entry.id, index]),
  );
  const localGraphNeighborCount = localGraphNodeOrder.size;
  const scopedGraphNodes = localGraphScopeActive
    ? graphNodes.map((entry) => {
      if (!activeLocalGraphIds.has(entry.id)) return entry;
      if (draggedGraphPositions[entry.id]) return entry;
      if (entry.id === activeGraphId) return { ...entry, x: localGraphCenter.x, y: localGraphCenter.y };
      const neighborIndex = localGraphNodeOrder.get(entry.id);
      if (neighborIndex === undefined) return entry;
      const angle = localGraphNeighborCount === 1
        ? -Math.PI / 2
        : -Math.PI / 2 + (neighborIndex / localGraphNeighborCount) * Math.PI * 2;
      const radius = Math.min(180, 112 + Math.sqrt(localGraphNeighborCount) * 8);
      return {
        ...entry,
        x: localGraphCenter.x + Math.cos(angle) * radius,
        y: localGraphCenter.y + Math.sin(angle) * radius * .86,
      };
    })
    : graphNodes;
  const graphInteractive = !localGraphScopeActive || graphBannerInteractive;
  useEffect(() => {
    if (!localGraphScopeActive || !graphBannerInteractive) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && graphCanvasRef.current?.contains(target)) return;
      setGraphBannerInteractive(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [localGraphScopeActive, graphBannerInteractive]);
  const graphFilterNeedle = graphFilterQuery.trim().toLowerCase();
  const visibleGraphNodes = scopedGraphNodes.filter((entry) => {
    if (localGraphScopeActive && !activeLocalGraphIds.has(entry.id)) return false;
    if (!graphShowOrphans && entry.linkCount === 0) return false;
    if (!graphFilterNeedle) return true;
    return [entry.label, entry.id, entry.group, text(entry.node.path || entry.node.wikiPath || '')]
      .join(' ')
      .toLowerCase()
      .includes(graphFilterNeedle);
  });
  const visibleGraphIds = new Set(visibleGraphNodes.map((entry) => entry.id));
  const visibleGraphEdges = graphLayoutEdges.filter((edge) => visibleGraphIds.has(text(edge.from)) && visibleGraphIds.has(text(edge.to)));
  const graphById = new Map(visibleGraphNodes.map((entry) => [entry.id, entry]));
  const activeGraphNode = graphById.get(activeGraphId);
  const connected = new Set<string>();
  visibleGraphEdges.forEach((edge) => {
    if (text(edge.from) === activeGraphId) connected.add(text(edge.to));
    if (text(edge.to) === activeGraphId) connected.add(text(edge.from));
  });
  const hoveredConnected = new Set<string>();
  if (hoveredGraphId) {
    hoveredConnected.add(hoveredGraphId);
    visibleGraphEdges.forEach((edge) => {
      const from = text(edge.from);
      const to = text(edge.to);
      if (from === hoveredGraphId) hoveredConnected.add(to);
      if (to === hoveredGraphId) hoveredConnected.add(from);
    });
  }
  const graphViewBox = graphLayout.viewBox;
  const viewBoxParts = graphViewBox.split(/\s+/).map(Number);
  const graphBox = {
    x: Number.isFinite(viewBoxParts[0]) ? viewBoxParts[0] : 0,
    y: Number.isFinite(viewBoxParts[1]) ? viewBoxParts[1] : 0,
    width: Number.isFinite(viewBoxParts[2]) ? viewBoxParts[2] : 960,
    height: Number.isFinite(viewBoxParts[3]) ? viewBoxParts[3] : 620,
  };
  const denseFocusZoomLabels = graphFocusMode && graphZoom >= 1.35 && (visibleGraphNodes.length > 220 || visibleGraphEdges.length > 180);
  const focusZoomRankedNodes = graphFocusMode && graphZoom >= 1.35
    ? visibleGraphNodes
      .filter((entry) => entry.linkCount > 0 && entry.id !== activeGraphId)
      .map((entry) => {
        const anchor = activeGraphNode || { x: graphBox.x + graphBox.width / 2, y: graphBox.y + graphBox.height / 2 };
        const distance = Math.hypot(entry.x - anchor.x, entry.y - anchor.y);
        const activeNeighborScore = connected.has(entry.id) ? 100000 : 0;
        return {
          id: entry.id,
          score: activeNeighborScore + entry.linkCount * 1000 - distance,
          label: entry.label,
        };
      })
      .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
    : [];
  const denseFocusProjectedPan = denseFocusZoomLabels && activeGraphNode
    ? {
      x: graphBox.x + graphBox.width * .52 - activeGraphNode.x * graphZoom,
      y: graphBox.y + graphBox.height * .105 - activeGraphNode.y * graphZoom,
    }
    : null;
  type SvgTextAnchor = 'start' | 'middle' | 'end' | 'inherit';
  type DenseFocusContextNode = {
    id: string;
    label: string;
    key: string;
    nodeRatio: { x: number; y: number };
    labelRatio: { x: number; y: number };
    labelLimit: number;
    labelAnchor: SvgTextAnchor;
    score: number;
  };
  const denseFocusContextNodes = denseFocusProjectedPan
    ? (() => {
      const slots: Array<Omit<DenseFocusContextNode, 'id' | 'label' | 'score'>> = [
      {
        key: 'left-context',
        nodeRatio: { x: .02, y: .58 },
        labelRatio: { x: .01, y: .648 },
        labelLimit: 36,
        labelAnchor: 'middle',
      },
      {
        key: 'right-context',
        nodeRatio: { x: .66, y: .92 },
        labelRatio: { x: .60, y: .617 },
        labelLimit: 38,
        labelAnchor: 'start',
      },
      ];
      const selectedIds = new Set<string>();
      return slots.map((slot) => {
        const preferredGroup = slot.key === 'left-context' ? '1_raw' : '3_output';
        const selected = visibleGraphNodes
          .filter((entry) => entry.id !== activeGraphId && entry.linkCount > 0 && !selectedIds.has(entry.id))
          .map((entry) => {
            const projected = {
              x: (entry.x * graphZoom + denseFocusProjectedPan.x - graphBox.x) / graphBox.width,
              y: (entry.y * graphZoom + denseFocusProjectedPan.y - graphBox.y) / graphBox.height,
            };
            const distance = Math.hypot(projected.x - slot.nodeRatio.x, projected.y - slot.nodeRatio.y);
            return {
              id: entry.id,
              label: entry.label,
              key: slot.key,
              nodeRatio: slot.nodeRatio,
              labelRatio: slot.labelRatio,
              labelLimit: slot.labelLimit,
              labelAnchor: slot.labelAnchor,
              score: (entry.group === preferredGroup || entry.id.startsWith(`${preferredGroup}/`) ? 200000 : 0) + (connected.has(entry.id) ? 100000 : 0) + entry.linkCount * 1000 - distance,
            };
          })
          .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))[0];
        if (selected) selectedIds.add(selected.id);
        return selected;
      }).filter((entry): entry is DenseFocusContextNode => Boolean(entry));
    })()
    : [];
  const denseFocusContextById = new Map(denseFocusContextNodes.map((entry) => [entry.id, entry]));
  const focusZoomLabelIds = new Set<string>();
  if (focusZoomRankedNodes.length) {
    const labelLimit = denseFocusZoomLabels ? 0 : visibleGraphNodes.length;
    focusZoomRankedNodes
      .slice(0, labelLimit)
      .forEach((entry) => focusZoomLabelIds.add(entry.id));
  }
  denseFocusContextNodes.forEach((entry) => focusZoomLabelIds.add(entry.id));
  const focusZoomRenderIds = new Set<string>();
  const focusZoomEdgeIds = new Set<string>();
  if (denseFocusZoomLabels) {
    if (activeGraphId) focusZoomRenderIds.add(activeGraphId);
    if (activeGraphId) focusZoomEdgeIds.add(activeGraphId);
    focusZoomRankedNodes.slice(0, 40).forEach((entry) => focusZoomEdgeIds.add(entry.id));
    denseFocusContextNodes.forEach((entry) => focusZoomRenderIds.add(entry.id));
    denseFocusContextNodes.forEach((entry) => focusZoomEdgeIds.add(entry.id));
  }
  const renderedGraphNodes = denseFocusZoomLabels
    ? visibleGraphNodes.filter((entry) => focusZoomRenderIds.has(entry.id))
    : visibleGraphNodes;
  const renderedGraphEdges = denseFocusZoomLabels
    ? visibleGraphEdges
      .filter((edge) => focusZoomEdgeIds.has(text(edge.from)) && focusZoomEdgeIds.has(text(edge.to)))
      .sort((left, right) => {
        const leftFrom = text(left.from);
        const leftTo = text(left.to);
        const rightFrom = text(right.from);
        const rightTo = text(right.to);
        const scoreEdge = (from: string, to: string) => (
          (from === activeGraphId || to === activeGraphId ? 1000 : 0) +
          (denseFocusContextById.has(from) || denseFocusContextById.has(to) ? 100 : 0)
        );
        return scoreEdge(rightFrom, rightTo) - scoreEdge(leftFrom, leftTo) || text(left.id).localeCompare(text(right.id));
      })
      .slice(0, 36)
    : visibleGraphEdges;
  const activeGraphX = activeGraphNode?.x;
  const activeGraphY = activeGraphNode?.y;
  const clampGraphZoom = (value: number) => Math.min(3, Math.max(.45, value));
  const resetGraphView = () => {
    setGraphZoom(1);
    setGraphPan({ x: 0, y: 0 });
  };
  const graphPoint = (event: { currentTarget: Element; clientX: number; clientY: number }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: graphBox.x + ((event.clientX - rect.left) / rect.width) * graphBox.width,
      y: graphBox.y + ((event.clientY - rect.top) / rect.height) * graphBox.height,
    };
  };
  const graphContentPoint = (event: { currentTarget: Element; clientX: number; clientY: number }) => {
    const point = graphPoint(event);
    return {
      x: (point.x - graphPan.x) / graphZoom,
      y: (point.y - graphPan.y) / graphZoom,
    };
  };
  const zoomAt = (nextZoom: number, anchor: { x: number; y: number }) => {
    const clamped = clampGraphZoom(nextZoom);
    setGraphPan({
      x: anchor.x - ((anchor.x - graphPan.x) / graphZoom) * clamped,
      y: anchor.y - ((anchor.y - graphPan.y) / graphZoom) * clamped,
    });
    setGraphZoom(clamped);
  };
  const graphCenter = { x: graphBox.x + graphBox.width / 2, y: graphBox.y + graphBox.height / 2 };
  useEffect(() => {
    if (!denseFocusZoomLabels || !Number.isFinite(activeGraphX) || !Number.isFinite(activeGraphY)) return;
    const target = { x: graphBox.x + graphBox.width * .52, y: graphBox.y + graphBox.height * .075 };
    const nextPan = {
      x: target.x - Number(activeGraphX) * graphZoom,
      y: target.y - Number(activeGraphY) * graphZoom,
    };
    setGraphPan((current) => (
      Math.hypot(current.x - nextPan.x, current.y - nextPan.y) < .5 ? current : nextPan
    ));
  }, [denseFocusZoomLabels, activeGraphX, activeGraphY, graphBox.x, graphBox.y, graphBox.width, graphBox.height, graphZoom]);
  const fitLocalGraphView = () => {
    const localNodes = graphNodes.filter((entry) => activeLocalGraphIds.has(entry.id));
    if (!localNodes.length) return;
    const xs = localNodes.map((entry) => entry.x);
    const ys = localNodes.map((entry) => entry.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const localWidth = Math.max(120, maxX - minX + 104);
    const localHeight = Math.max(100, maxY - minY + 88);
    const nextZoom = Math.min(2.25, clampGraphZoom(Math.min(graphBox.width / localWidth, graphBox.height / localHeight) * .74));
    const localCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    setGraphZoom(nextZoom);
    setGraphPan({
      x: graphCenter.x - localCenter.x * nextZoom,
      y: graphCenter.y - localCenter.y * nextZoom,
    });
  };
  const updateGraphLocalMode = (enabled: boolean) => {
    setGraphLocalMode(enabled);
    setGraphBannerInteractive(false);
    if (enabled && localGraphHasActive) window.requestAnimationFrame(fitLocalGraphView);
    else resetGraphView();
  };
  return <>
      <section className="wiki-graph-panel">
        <header><strong>지식 그래프</strong><small>{localGraphScopeActive ? '로컬 그래프 · ' : ''}{visibleGraphNodes.length}개 노트 · {visibleGraphEdges.length}개 링크</small><i />{graphGroups.slice(0, 5).map((tag) => <span className="wiki-legend" key={tag}><b style={{ background: colors[tag] || colors.기타 }} />{tag}</span>)}</header>
        <div ref={graphCanvasRef} className="wiki-graph-canvas view-content graph-banner-content" data-panning={graphPanning} data-interactive={graphInteractive} data-scope={localGraphScopeActive ? 'local' : 'global'} data-sparse={visibleGraphNodes.length > 0 && visibleGraphNodes.length <= 6} data-dense-focus={denseFocusZoomLabels} data-focus-zoom={graphFocusMode && graphZoom >= 1.35} data-timelapse={graphTimelapseActive} style={{ '--wiki-edge-opacity': graphLinkOpacity, '--wiki-edge-scale': graphLinkScale } as CSSProperties} tabIndex={0} onKeyDown={(event) => {
          if (!event.metaKey && !event.ctrlKey) return;
          if (event.key === '+' || event.key === '=') {
            event.preventDefault();
            zoomAt(graphZoom * 1.42, graphCenter);
          } else if (event.key === '-' || event.key === '_') {
            event.preventDefault();
            zoomAt(graphZoom / 1.42, graphCenter);
          } else if (event.key === '0') {
            event.preventDefault();
            resetGraphView();
          }
        }} onWheel={(event) => { event.preventDefault(); zoomAt(graphZoom * (event.deltaY > 0 ? .86 : 1.16), graphPoint(event)); }}>
          {graphTimelapseActive && <div className="wiki-graph-timelapse" aria-label="타임랩스 재생 중"><span /></div>}
          {localGraphScopeActive && <button className="wiki-graph-banner-overlay graph-banner-overlay" type="button" aria-label="로컬 그래프 활성화" onClick={(event) => { event.stopPropagation(); setGraphBannerInteractive(true); }} onPointerUp={(event) => { event.stopPropagation(); setGraphBannerInteractive(true); }} />}
          <div className={`wiki-graph-controls graph-controls${graphInteractive ? '' : ' is-close'}`} aria-label="그래프 확대 축소">
            <button aria-label="그래프 확대" onClick={() => zoomAt(graphZoom * 1.18, graphCenter)}>+</button>
            <button aria-label="그래프 축소" onClick={() => zoomAt(graphZoom / 1.18, graphCenter)}>−</button>
            <button aria-label="그래프 위치 초기화" onClick={resetGraphView}>⌂</button>
            <span>{Math.round(graphZoom * 100)}%</span>
          </div>
          <svg className="wiki-graph-svg" viewBox={graphViewBox} preserveAspectRatio="xMidYMid meet" onPointerDown={(event) => {
            if (!graphInteractive) return;
            const target = event.target as Element;
            if (target.closest('.wiki-svg-node')) return;
            graphDragRef.current = { x: event.clientX, y: event.clientY, panX: graphPan.x, panY: graphPan.y };
            setGraphPanning(true);
            event.currentTarget.setPointerCapture(event.pointerId);
          }} onPointerMove={(event) => {
            if (graphNodeDragRef.current) {
              const point = graphContentPoint(event);
              const drag = graphNodeDragRef.current;
              const nextX = drag.nodeX + point.x - drag.x;
              const nextY = drag.nodeY + point.y - drag.y;
              const moved = drag.moved || Math.hypot(point.x - drag.x, point.y - drag.y) > 4;
              graphNodeDragRef.current = { ...drag, moved };
              if (moved) suppressGraphClickRef.current = true;
              setDraggedGraphPositions((current) => ({ ...current, [drag.id]: { x: nextX, y: nextY } }));
              return;
            }
            if (!graphDragRef.current) return;
            const rect = event.currentTarget.getBoundingClientRect();
            setGraphPan({
              x: graphDragRef.current.panX + ((event.clientX - graphDragRef.current.x) * graphBox.width / rect.width),
              y: graphDragRef.current.panY + ((event.clientY - graphDragRef.current.y) * graphBox.height / rect.height),
            });
          }} onPointerUp={(event) => {
            if (graphNodeDragRef.current) {
              const finishedDrag = graphNodeDragRef.current;
              if (finishedDrag.moved) {
                suppressGraphClickRef.current = true;
                window.setTimeout(() => { suppressGraphClickRef.current = false; }, 0);
              } else {
                const now = Date.now();
                const previous = lastGraphClickRef.current;
                onOpenDocument(finishedDrag.id, previous?.id === finishedDrag.id && now - previous.at < 360 ? 'open' : 'select');
                lastGraphClickRef.current = { id: finishedDrag.id, at: now };
              }
              graphNodeDragRef.current = null;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
              return;
            }
            graphDragRef.current = null;
            setGraphPanning(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }} onPointerCancel={() => {
            graphNodeDragRef.current = null;
            graphDragRef.current = null;
            setGraphPanning(false);
          }}>
            <rect className="wiki-graph-bg" x="0" y="0" width="100%" height="100%" />
            <g className="wiki-graph-viewport" transform={`translate(${graphPan.x} ${graphPan.y}) scale(${graphZoom})`}>
              {renderedGraphEdges.map((edge, index) => {
                const from = graphById.get(text(edge.from));
                const to = graphById.get(text(edge.to));
                if (!from || !to) return null;
                const hot = from.id === activeGraphId || to.id === activeGraphId;
                const focus = Boolean(hoveredGraphId && (from.id === hoveredGraphId || to.id === hoveredGraphId));
                const muted = Boolean(hoveredGraphId && !focus);
                return <line className="wiki-edge" data-hot={hot} data-focus={focus} data-muted={muted} key={text(edge.id, `edge-${index}`)} x1={from.x} y1={from.y} x2={to.x} y2={to.y} />;
              })}
              {renderedGraphNodes.map((entry) => {
                const activeNode = entry.id === activeGraphId;
                const contextPlacement = denseFocusContextById.get(entry.id);
                const contextPinned = contextPlacement && !draggedGraphPositions[entry.id] ? contextPlacement : undefined;
                const pinnedDenseLabel = Boolean(denseFocusZoomLabels && focusZoomLabelIds.has(entry.id));
                const nodeX = contextPinned
                  ? (graphBox.x + graphBox.width * contextPinned.nodeRatio.x - graphPan.x) / graphZoom
                  : entry.x;
                const nodeY = contextPinned
                  ? (graphBox.y + graphBox.height * contextPinned.nodeRatio.y - graphPan.y) / graphZoom
                  : entry.y;
                const labelOverride = contextPinned
                  ? {
                    x: (graphBox.x + graphBox.width * contextPinned.labelRatio.x - graphPan.x) / graphZoom,
                    y: (graphBox.y + graphBox.height * contextPinned.labelRatio.y - graphPan.y) / graphZoom,
                  }
                  : null;
                const focusZoomLabel = graphFocusMode && graphZoom >= 1.35 && (entry.linkCount > 0 || focusZoomLabelIds.has(entry.id)) && (!denseFocusZoomLabels || focusZoomLabelIds.has(entry.id));
                const visibleLabel = activeNode || (graphShowLabels && (denseFocusZoomLabels ? focusZoomLabel : (entry.linkCount > 4 || focusZoomLabel)));
                const focus = Boolean(hoveredGraphId && hoveredConnected.has(entry.id));
                const muted = Boolean(hoveredGraphId && !hoveredConnected.has(entry.id) && !activeNode && !pinnedDenseLabel);
                const labelSource = activeGraphNode || { x: graphBox.x + graphBox.width / 2, y: graphBox.y + graphBox.height / 2 };
                const labelAngle = activeNode ? -.22 : Math.atan2(nodeY - labelSource.y, nodeX - labelSource.x);
                const labelVectorX = Math.cos(labelAngle);
                const labelVectorY = Math.sin(labelAngle);
                const labelOffset = entry.r * graphNodeScale + (focusZoomLabel ? 24 : 5);
                const labelX = labelOverride?.x ?? (focusZoomLabel || activeNode ? nodeX + labelVectorX * labelOffset : nodeX + labelOffset);
                const labelY = labelOverride?.y ?? (focusZoomLabel || activeNode ? nodeY + labelVectorY * labelOffset + 1 : nodeY + 4);
                const labelAnchor = labelOverride ? (contextPlacement?.labelAnchor || 'middle') : focusZoomLabel || activeNode
                  ? labelVectorX < -.22 ? 'end' : labelVectorX > .22 ? 'start' : 'middle'
                  : 'start';
                const graphLabel = denseFocusZoomLabels
                  ? wikiBasename(text(entry.node.path || entry.node.wikiPath || entry.id, entry.label))
                  : entry.label;
                const labelLimit = contextPlacement?.labelLimit ?? 28;
                return <g className="wiki-svg-node" data-active={activeNode} data-connected={connected.has(entry.id)} data-isolated={entry.linkCount === 0 ? 'true' : 'false'} data-hub={entry.linkCount > 3 ? 'true' : 'false'} data-focus={focus} data-muted={muted} data-context={Boolean(contextPlacement)} key={entry.id} onPointerEnter={() => { if (graphInteractive) setHoveredGraphId(entry.id); }} onPointerLeave={() => { if (graphInteractive && !graphNodeDragRef.current) setHoveredGraphId(''); }} onPointerDown={(event) => {
                  if (!graphInteractive) return;
                  event.stopPropagation();
                  const point = graphContentPoint({ currentTarget: event.currentTarget.ownerSVGElement || event.currentTarget, clientX: event.clientX, clientY: event.clientY });
                  graphNodeDragRef.current = { id: entry.id, x: point.x, y: point.y, nodeX: entry.x, nodeY: entry.y, moved: false };
                  setHoveredGraphId(entry.id);
                  event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
                }} onClick={(event) => {
                  if (suppressGraphClickRef.current) {
                    event.preventDefault();
                    suppressGraphClickRef.current = false;
                    return;
                  }
                  onOpenDocument(entry.id, event.detail >= 2 ? 'open' : 'select');
                }}>
                  <circle cx={nodeX} cy={nodeY} r={entry.r * graphNodeScale} />
                  <title>{graphLabel}</title>
                  {visibleLabel && <text x={labelX} y={labelY} textAnchor={labelAnchor} dominantBaseline="middle">{graphLabel.slice(0, labelLimit)}</text>}
                </g>;
              })}
            </g>
          </svg>
          <div className="wiki-graph-side-actions" aria-label="그래프 도구">
            <button type="button" aria-label={graphFocusMode ? '문서 트리 같이 보기' : '그래프 집중 보기'} data-active={graphFocusMode} data-graph-control="fullscreen" onClick={() => onFocusModeChange(!graphFocusMode)}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4" /><path d="M9 9 4.8 4.8M15 9l4.2-4.2M9 15l-4.2 4.2M15 15l4.2 4.2" /></svg>
            </button>
            <button type="button" aria-label={graphLocalMode ? '전체 그래프 보기' : '로컬 그래프 보기'} data-active={graphLocalMode} data-graph-control="local-graph" onClick={() => updateGraphLocalMode(!graphLocalMode)}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2" /><path d="M12 4v3M12 17v3M4 12h3M17 12h3M6.6 6.6l2.1 2.1M15.3 15.3l2.1 2.1M17.4 6.6l-2.1 2.1M8.7 15.3l-2.1 2.1" /></svg>
            </button>
            <button type="button" aria-label="그래프 설정 열기" data-active={graphSettingsOpen} data-graph-control="settings" onClick={() => setGraphSettingsOpen((value) => !value)}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M4.8 7.2l2.1 2.1M17.1 14.7l2.1 2.1M3 12h3M18 12h3M4.8 16.8l2.1-2.1M17.1 9.3l2.1-2.1" /></svg>
            </button>
            <button type="button" aria-label="타임랩스 애니메이션 시작" data-active={graphTimelapseActive} data-graph-control="timelapse" onClick={() => setGraphTimelapseActive((value) => !value)}>
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 12c2.4-4.8 5.6-4.8 8 0s5.6 4.8 8 0" /><path d="M4 17c2.4-4.8 5.6-4.8 8 0s5.6 4.8 8 0" /></svg>
            </button>
          </div>
          {graphSettingsOpen && <aside className="wiki-graph-settings" aria-label="그래프 설정">
            <header><strong>그래프 설정</strong><button type="button" aria-label="그래프 설정 닫기" onClick={() => setGraphSettingsOpen(false)}>×</button></header>
            <section>
              <h4>필터</h4>
              <label className="wiki-graph-search"><span>⌕</span><input aria-label="그래프 필터" value={graphFilterQuery} onChange={(event) => setGraphFilterQuery(event.target.value)} placeholder="파일 검색" /></label>
              <label className="wiki-graph-toggle"><input aria-label="선택 노트 로컬 그래프" type="checkbox" checked={graphLocalMode} onChange={(event) => updateGraphLocalMode(event.target.checked)} /> 선택 노트 로컬 그래프</label>
              <label className="wiki-graph-toggle"><input aria-label="고립 노드 표시" type="checkbox" checked={graphShowOrphans} onChange={(event) => setGraphShowOrphans(event.target.checked)} /> 고립 노드 표시</label>
            </section>
            <section>
              <h4>그룹</h4>
              <div className="wiki-graph-groups">
                {graphGroups.slice(0, 6).map((tag) => <span key={tag}><b style={{ background: colors[tag] || colors.기타 }} />{tag}<em>{graphNodes.filter((node) => node.group === tag).length}</em></span>)}
              </div>
            </section>
            <section>
              <h4>표시</h4>
              <label className="wiki-graph-toggle"><input type="checkbox" checked={graphShowLabels} onChange={(event) => setGraphShowLabels(event.target.checked)} /> 이름 표시</label>
              <label><span>노드 크기</span><input type="range" min=".7" max="1.7" step=".05" value={graphNodeScale} onChange={(event) => setGraphNodeScale(Number(event.target.value))} /></label>
              <label><span>링크 두께</span><input type="range" min=".6" max="1.9" step=".05" value={graphLinkScale} onChange={(event) => setGraphLinkScale(Number(event.target.value))} /></label>
              <label><span>링크 밝기</span><input type="range" min=".18" max=".9" step=".04" value={graphLinkOpacity} onChange={(event) => setGraphLinkOpacity(Number(event.target.value))} /></label>
            </section>
            <section>
              <h4>동작</h4>
              <label><span>중심 힘</span><input aria-label="중심 힘" type="range" min=".4" max="1.8" step=".05" value={graphCenterForce} onChange={(event) => { setGraphCenterForce(Number(event.target.value)); setDraggedGraphPositions({}); }} /></label>
              <label><span>반발 힘</span><input aria-label="반발 힘" type="range" min=".65" max="1.55" step=".05" value={graphRepelForce} onChange={(event) => { setGraphRepelForce(Number(event.target.value)); setDraggedGraphPositions({}); }} /></label>
              <label><span>링크 거리</span><input aria-label="링크 거리" type="range" min=".65" max="1.55" step=".05" value={graphLinkDistance} onChange={(event) => { setGraphLinkDistance(Number(event.target.value)); setDraggedGraphPositions({}); }} /></label>
              <button type="button" onClick={resetGraphView}>화면 맞추기</button>
              <button type="button" onClick={() => setDraggedGraphPositions({})}>노드 위치 초기화</button>
            </section>
          </aside>}
          {children}
        </div>
      </section>
  </>;
}
