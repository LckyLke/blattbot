/* One accessible player. Other clips are loaded only when selected. */
(() => {
  const demos = {
    workflow: {
      label: 'Edit and approve',
      caption: 'One complete edit: ask the assistant, check the PDF, review the diff and approve.',
      steps: ['Open a project with the assistant beside the compiled PDF.', 'Ask for a change in plain language.', 'Watch the agent edit the LaTeX and compile the document.', 'Read the exact diff and inspect the resulting PDF.', 'Approve the change to save it to the local project history.'],
      note: 'Recorded with a real agent turn in a local project. Waiting periods are shortened. On a connected project, approval can also push the changes to Overleaf.',
    },
    evidence: {
      label: 'Read and verify',
      caption: 'Follow a citation back to the paper, then find relevant passages across your library.',
      steps: ['Inspect the status of cited passages in the draft.', 'Expand an assessment and open its quoted source passage with the PDF page number.', 'Search the indexed library for passages from your papers.', 'Use strict mode to keep unresolved passages open before approval.'],
      note: 'Evidence assessments are prepared before recording. Model checks remain fallible; read the source and review the result.',
    },
    graph: {
      label: 'Connect your sources',
      caption: 'See which papers connect, then discover shared references missing from your project.',
      steps: ['Open the automatically built citation graph.', 'Switch between project papers and the surrounding literature.', 'Select a source to inspect its citation connections.', 'Find missing sources and compare the references shared by two papers.'],
      note: 'The citation index is retrieved before recording. Connections retain their source metadata and provide leads for further reading.',
    },
    writing: {
      label: 'Find and refine',
      caption: 'Search the source and PDF side by side, refine a passage and inspect the change.',
      steps: ['Open the LaTeX source beside the compiled PDF.', 'Use Ctrl/Cmd+F to find a phrase in the source.', 'Search the PDF and step through precisely highlighted matches.', 'Refine the source and review the saved change in Proof.'],
      note: 'A manual edit in the real source editor. The saved change is compiled and shown in Proof for review.',
    },
  };
  const video = document.getElementById('walkthrough');
  const toggle = document.getElementById('demo-play');
  const buttons = [...document.querySelectorAll('[data-demo]')];
  const panel = document.getElementById('demo-panel');
  let current = 'workflow';
  function select(key, play = true) {
    if (!demos[key]) return;
    const demo = demos[key];
    buttons.forEach(button => {
      const selected = button.dataset.demo === key;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', `demo-${key}`);
    video.setAttribute('aria-label', demo.label);
    document.getElementById('demo-caption').textContent = demo.caption;
    document.getElementById('demo-note').textContent = demo.note;
    document.getElementById('demo-transcript').replaceChildren(...demo.steps.map(text => {
      const item = document.createElement('li'); item.textContent = text; return item;
    }));
    if (key !== current) {
      current = key;
      video.poster = `assets/${key}-poster.webp`;
      video.querySelector('source').src = `assets/${key}.mp4`;
      video.querySelector('track').src = `assets/${key}.vtt`;
      video.querySelector('a').href = `assets/${key}.mp4`;
      video.load();
    }
    if (play) video.play().catch(() => {});
  }
  buttons.forEach(button => {
    button.addEventListener('click', () => select(button.dataset.demo));
    button.addEventListener('keydown', event => {
      let next = buttons.indexOf(button);
      if (event.key === 'ArrowRight') next++;
      else if (event.key === 'ArrowLeft') next--;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = buttons.length - 1;
      else return;
      event.preventDefault();
      const target = buttons[(next + buttons.length) % buttons.length];
      target.focus();
      select(target.dataset.demo, false);
    });
  });
  document.querySelectorAll('[data-watch]').forEach(link => link.addEventListener('click', () => select(link.dataset.watch)));
  toggle.addEventListener('click', () => video.paused ? video.play().catch(() => {}) : video.pause());
  const update = () => { toggle.textContent = video.paused ? 'Play walkthrough ▶' : 'Pause walkthrough Ⅱ'; };
  video.addEventListener('play', update);
  video.addEventListener('pause', update);
  video.addEventListener('error', () => { document.getElementById('demo-caption').textContent = 'The video could not load. Read the walkthrough below or try again.'; });
  // No automatic motion. Users start a walkthrough explicitly, including with reduced motion/data saving.
  document.addEventListener('visibilitychange', () => { if (document.hidden) video.pause(); });
  if ('IntersectionObserver' in window) new IntersectionObserver(entries => {
    if (!entries[0].isIntersecting) video.pause();
  }, { threshold: 0.05 }).observe(video);
})();
