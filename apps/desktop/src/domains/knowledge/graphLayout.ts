import { knowledgeText } from './primitives';
import type { KnowledgeItem, WikiGraphLayoutOptions } from './types';

export function hashText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function buildWikiGraphLayout(rawNodes: KnowledgeItem[], fallbackNodes: KnowledgeItem[], rawEdges: KnowledgeItem[], options: WikiGraphLayoutOptions = {}) {
  const sourceNodes = rawNodes.length ? rawNodes : fallbackNodes;
  const width = 960;
  const height = 620;
  const centerX = width / 2;
  const centerY = height / 2;
  const centerForce = Number.isFinite(options.centerForce) ? Number(options.centerForce) : 1;
  const repelForce = Number.isFinite(options.repelForce) ? Number(options.repelForce) : 1;
  const linkDistance = Number.isFinite(options.linkDistance) ? Number(options.linkDistance) : 1;
  const groups = Array.from(new Set(sourceNodes.map(
    (node) => knowledgeText(node.group || node.folder || node.kind, '기타'),
  )));
  const nodeId = (node: KnowledgeItem, index: number) => knowledgeText(node.path || node.wikiPath || node.id || node._id || node.key, `wiki-${index}`);
  const nodeAliases = (node: KnowledgeItem, id: string) => [
    id,
    knowledgeText(node.id),
    knowledgeText(node._id),
    knowledgeText(node.key),
    knowledgeText(node.path),
    knowledgeText(node.wikiPath),
    knowledgeText(node.title),
    knowledgeText(node.label),
  ].filter(Boolean);
  const nodes = sourceNodes.map((node, index) => {
    const id = nodeId(node, index);
    const seed = hashText(`${id}:${knowledgeText(node.title || node.path)}`);
    const angle = ((seed % 10000) / 10000) * Math.PI * 2;
    const radius = 36 + (((seed >>> 8) % 1000) / 1000) * 82;
    const group = knowledgeText(node.group || node.folder || node.kind, '기타');
    return {
      node,
      id,
      x: Number.isFinite(Number(node.x))
        ? Number(node.x)
        : centerX + Math.cos(angle) * radius,
      y: Number.isFinite(Number(node.y))
        ? Number(node.y)
        : centerY + Math.sin(angle) * radius * .78,
      vx: 0,
      vy: 0,
      r: 4,
      label: knowledgeText(node.label || node.title || node.path, '노트'),
      group,
      linkCount: 0,
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const aliases = new Map<string, string>();
  nodes.forEach((node) => {
    nodeAliases(node.node, node.id).forEach((alias) => aliases.set(alias, node.id));
  });
  const edges = rawEdges
    .map((edge, index) => {
      const from = aliases.get(knowledgeText(edge.from)) || knowledgeText(edge.from);
      const to = aliases.get(knowledgeText(edge.to)) || knowledgeText(edge.to);
      return {
        id: knowledgeText(edge.id, `edge-${index}`),
        from,
        to,
      };
    })
    .filter((edge) => edge.from && edge.to && byId.has(edge.from) && byId.has(edge.to));

  const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  edges.forEach((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from) from.linkCount += 1;
    if (to) to.linkCount += 1;
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  });

  nodes.forEach((node) => {
    const explicitRadius = Number(node.node.r);
    node.r = Number.isFinite(explicitRadius)
      ? explicitRadius
      : node.linkCount
        ? Math.min(13, 3.4 + Math.sqrt(node.linkCount) * 2.35)
        : 2.8;
  });

  const linkedNodes = nodes.filter((node) => node.linkCount > 0);
  const isolatedNodes = nodes.filter((node) => node.linkCount === 0);
  const usesOpenGraphBounds = nodes.length > 220;
  const components: typeof nodes[] = [];
  const visited = new Set<string>();
  linkedNodes
    .slice()
    .sort((a, b) => b.linkCount - a.linkCount || a.label.localeCompare(b.label))
    .forEach((start) => {
      if (visited.has(start.id)) return;
      const component: typeof nodes = [];
      const stack = [start.id];
      visited.add(start.id);
      while (stack.length) {
        const currentId = stack.pop() || '';
        const current = byId.get(currentId);
        if (current) component.push(current);
        adjacency.get(currentId)?.forEach((nextId) => {
          const next = byId.get(nextId);
          if (!next || next.linkCount === 0 || visited.has(nextId)) return;
          visited.add(nextId);
          stack.push(nextId);
        });
      }
      components.push(component);
    });

  components.sort((a, b) => b.length - a.length);
  const componentCenters = new Map<string, { x: number; y: number }>();
  components.forEach((component, componentIndex) => {
    const satelliteAngle = (
      (componentIndex - 1) / Math.max(components.length - 1, 1)
    ) * Math.PI * 2 - Math.PI / 2;
    const baseCenter = componentIndex === 0
      ? { x: centerX - 10, y: centerY + 12 }
      : {
        x: centerX + Math.cos(satelliteAngle) * 210,
        y: centerY + Math.sin(satelliteAngle) * 145,
      };
    const componentRadius = Math.min(165, Math.max(44, 25 + Math.sqrt(component.length) * 22)) * linkDistance;
    component
      .slice()
      .sort((a, b) => b.linkCount - a.linkCount || a.label.localeCompare(b.label))
      .forEach((node, index) => {
        const seed = hashText(`${node.id}:linked:${componentIndex}`);
        const angle = index === 0
          ? 0
          : ((index - 1) / Math.max(component.length - 1, 1)) * Math.PI * 2
            + ((seed % 1000) / 1000) * .28;
        const radius = index === 0
          ? 0
          : componentRadius * (.45 + (((seed >>> 9) % 1000) / 1000) * .4);
        node.x = baseCenter.x + Math.cos(angle) * radius;
        node.y = baseCenter.y + Math.sin(angle) * radius * .78;
        componentCenters.set(node.id, baseCenter);
      });
  });

  const orderedIsolates = isolatedNodes
    .slice()
    .sort((a, b) => hashText(a.id) - hashText(b.id) || a.label.localeCompare(b.label));
  orderedIsolates.forEach((node, index) => {
    const seed = hashText(`${node.id}:isolate`);
    const scatter = (shift: number) => ((seed >>> shift) % 1000) / 1000;
    const lane = (index + (seed % 7)) % 5;
    const left = 58 + scatter(3) * 252;
    const right = width - 58 - scatter(5) * 252;
    const top = 58 + scatter(7) * 128;
    const bottom = height - 58 - scatter(9) * 128;
    const middleX = 180 + scatter(11) * 600;
    const base = lane === 0
      ? { x: left, y: 92 + scatter(15) * 438 }
      : lane === 1
        ? { x: right, y: 92 + scatter(17) * 438 }
        : lane === 2
          ? { x: middleX, y: top }
          : lane === 3
            ? { x: middleX, y: bottom }
            : { x: 86 + scatter(19) * 788, y: 74 + scatter(21) * 472 };
    const forceScale = .5 + Math.sqrt(Math.max(.1, repelForce)) * .5;
    const dx = (base.x - centerX) * forceScale;
    const dy = (base.y - centerY) * forceScale;
    const centerEllipse = (dx * dx) / (180 * 180) + (dy * dy) / (125 * 125);
    if (centerEllipse < 1) {
      const angle = Math.atan2(dy || .1, dx || .1);
      node.x = Math.min(width - 58, Math.max(58, centerX + Math.cos(angle) * 238 * Math.sqrt(repelForce)));
      node.y = Math.min(height - 58, Math.max(58, centerY + Math.sin(angle) * 172 * Math.sqrt(repelForce)));
    } else {
      node.x = Math.min(width - 58, Math.max(58, centerX + dx));
      node.y = Math.min(height - 58, Math.max(58, centerY + dy));
    }
  });

  const iterations = linkedNodes.length > 650 ? 90 : linkedNodes.length > 320 ? 120 : 165;
  const repelDistance = linkedNodes.length > 650 ? 130 : 210;
  for (let step = 0; step < iterations; step += 1) {
    for (let left = 0; left < linkedNodes.length; left += 1) {
      const a = linkedNodes[left];
      for (let right = left + 1; right < linkedNodes.length; right += 1) {
        const b = linkedNodes[right];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distanceSq = dx * dx + dy * dy;
        if (distanceSq < .01) {
          const jitter = hashText(`${a.id}:${b.id}`) / 0xffffffff;
          dx = Math.cos(jitter * Math.PI * 2) * .1;
          dy = Math.sin(jitter * Math.PI * 2) * .1;
          distanceSq = dx * dx + dy * dy;
        }
        if (distanceSq > repelDistance * repelDistance) continue;
        const distance = Math.sqrt(distanceSq);
        const force = ((72 + a.r * b.r * 6.2) * repelForce) / distanceSq;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    edges.forEach((edge) => {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) return;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = (48 + Math.min(34, (from.r + to.r) * 2.2)) * linkDistance;
      const force = (distance - target) * .021;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      from.vx += fx;
      from.vy += fy;
      to.vx -= fx;
      to.vy -= fy;
    });

    linkedNodes.forEach((node) => {
      const target = componentCenters.get(node.id) || { x: centerX, y: centerY };
      const centerPull = (node.linkCount > 2 ? .0024 : .0015) * centerForce;
      node.vx += (target.x - node.x) * centerPull + (centerX - node.x) * .0008;
      node.vy += (target.y - node.y) * centerPull + (centerY - node.y) * .0008;
      node.vx *= .76;
      node.vy *= .76;
      node.x = usesOpenGraphBounds
        ? Math.min(width + 240, Math.max(-240, node.x + node.vx))
        : Math.min(width - 58, Math.max(58, node.x + node.vx));
      node.y = usesOpenGraphBounds
        ? Math.min(height + 155, Math.max(-155, node.y + node.vy))
        : Math.min(height - 58, Math.max(58, node.y + node.vy));
    });
  }

  return {
    nodes: nodes.map(({ vx: _vx, vy: _vy, ...node }) => node),
    edges,
    groups,
    viewBox: `0 0 ${width} ${height}`,
  };
}
