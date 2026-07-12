const vaultRootNotes = [
  { id: '0_inbox/capture.md', path: '0_inbox/capture.md', title: 'Inbox capture', folder: '0_inbox', content: 'Inbox note.' },
  { id: '1_raw/source.md', path: '1_raw/source.md', title: 'Raw source', folder: '1_raw', content: 'Raw note.' },
  { id: '3_output/report.md', path: '3_output/report.md', title: 'Output report', folder: '3_output', content: 'Output note.' },
];

const linkedNotes = [
  { id: '2_wiki/hub.md', path: '2_wiki/hub.md', title: 'Hub strategy', folder: '2_wiki', content: 'Central hub.' },
  ...Array.from({ length: 12 }, (_, index) => ({
    id: `2_wiki/linked-${index + 1}.md`,
    path: `2_wiki/linked-${index + 1}.md`,
    title: `Linked note ${index + 1}`,
    folder: '2_wiki',
    content: `Linked body ${index + 1}.`,
  })),
];

const isolatedNotes = Array.from({ length: 64 }, (_, index) => ({
  id: `4_journal/2025-03-${String(index + 21).padStart(2, '0')}.md`,
  path: `4_journal/2025-03-${String(index + 21).padStart(2, '0')}.md`,
  title: `Daily isolate ${index + 1}`,
  folder: '4_journal',
  content: `Daily isolated note ${index + 1}.`,
}));

const recentJournalNote = {
  id: '4_journal/2026-07-06.md',
  path: '4_journal/2026-07-06.md',
  title: 'Recent journal note',
  folder: '4_journal',
  content: 'Recent journal body.',
};

const notes = [...vaultRootNotes, ...linkedNotes, recentJournalNote, ...isolatedNotes];
const graph = {
  groups: ['2_wiki', '4_journal'],
  nodes: notes.map((note) => ({
    id: note.path,
    path: note.path,
    title: note.title,
    label: note.title,
    group: note.folder,
  })),
  edges: linkedNotes.slice(1).map((note, index) => ({
    id: `hub-edge-${index + 1}`,
    from: '2_wiki/hub.md',
    to: note.path,
  })),
};
const wiki = { notes, documents: notes, graph, selectedNote: linkedNotes[0] };

const compactNotes = [
  { id: '2_wiki/hub.md', path: '2_wiki/hub.md', title: 'Hub strategy', folder: '2_wiki', content: 'Central hub links [[2_wiki/linked-a.md]] and [[Linked beta]].' },
  { id: '2_wiki/linked-a.md', path: '2_wiki/linked-a.md', title: 'Linked alpha', folder: '2_wiki', content: 'Linked alpha body with [[Hub strategy]].' },
  { id: '2_wiki/linked-b.md', path: '2_wiki/linked-b.md', title: 'Linked beta', folder: '2_wiki', content: 'Linked beta body.' },
  { id: '4_journal/isolated.md', path: '4_journal/isolated.md', title: 'Daily isolate', folder: '4_journal', content: 'Isolated body.' },
];
const compactGraph = {
  groups: ['2_wiki', '4_journal'],
  nodes: compactNotes.map((note) => ({
    id: note.path,
    path: note.path,
    title: note.title,
    label: note.title,
    group: note.folder,
  })),
  edges: [],
};
const compactWiki = { notes: compactNotes, documents: compactNotes, graph: compactGraph, selectedNote: compactNotes[0] };

async function routeCompactWikiApis(page) {
  await routeWikiPayload(page, compactWiki, compactNotes, compactGraph, compactNotes[0]);
}

async function routeWikiPayload(page, wikiPayload, notePayload, graphPayload, selectedNote) {
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (!path.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (request.method() === 'GET' && path === '/api/state') {
      await route.fulfill({ json: { ok: true, tasks: [], events: [], agents: [], runs: [], documents: [], chatMessages: [], wikiIndex: wikiPayload } });
      return;
    }
    if (request.method() === 'GET' && path === '/api/wiki') {
      await route.fulfill({ json: { ok: true, wikiIndex: wikiPayload, notes: notePayload, documents: notePayload, graph: graphPayload, selectedNote } });
      return;
    }
    await route.fulfill({ json: { ok: true, data: {} } });
  });
}

async function routeWikiApis(page) {
  await routeWikiPayload(page, wiki, notes, graph, linkedNotes[0]);
}

async function evaluateFocusGraphTone(page) {
  return page.evaluate(() => {
    const linkedLabels = [...document.querySelectorAll('.wiki-svg-node text')]
      .filter((label) => (label.textContent || '').startsWith('Linked note'));
    const hotEdges = [...document.querySelectorAll('.wiki-edge[data-hot="true"]')];
    const labelFontSizes = linkedLabels.map((label) => Number.parseFloat(getComputedStyle(label).fontSize || '0'));
    const edgeStyles = hotEdges.map((edge) => {
      const style = getComputedStyle(edge);
      return {
        opacity: Number.parseFloat(style.strokeOpacity || '0'),
        width: Number.parseFloat(style.strokeWidth || '0'),
      };
    });
    return {
      linkedLabelCount: linkedLabels.length,
      minLinkedLabelFontSize: Math.min(...labelFontSizes),
      maxHotEdgeOpacity: Math.max(...edgeStyles.map((style) => style.opacity)),
      maxHotEdgeWidth: Math.max(...edgeStyles.map((style) => style.width)),
    };
  });
}

module.exports = { evaluateFocusGraphTone, graph, isolatedNotes, linkedNotes, notes, routeCompactWikiApis, routeWikiApis };
