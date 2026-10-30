// MATLAB Figures panel controller: handles image display and before/after comparisons.

(function () {
  const container = document.getElementById('figures-container');
  const compareCheckbox = document.getElementById('compare-checkbox');

  let currentFigures = [];
  let previousFigures = [];
  let showComparison = false;

  compareCheckbox.addEventListener('change', (e) => {
    showComparison = e.target.checked;
    render();
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'updateFigures') {
      currentFigures = msg.current || [];
      previousFigures = msg.previous || [];
      render();
    }
  });

  function render() {
    container.innerHTML = '';

    if (currentFigures.length === 0 && previousFigures.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No figures generated yet. Run a script with plot() or figure() to display figures.';
      container.appendChild(empty);
      return;
    }

    const count = Math.max(currentFigures.length, showComparison ? previousFigures.length : 0);

    for (let i = 0; i < count; i++) {
      const card = document.createElement('div');
      card.className = 'figure-card';

      const header = document.createElement('div');
      header.className = 'figure-card-header';
      header.textContent = `Figure ${i + 1}`;
      card.appendChild(header);

      const imagesRow = document.createElement('div');
      imagesRow.className = 'figure-images';

      const curr = currentFigures[i];
      const prev = previousFigures[i];

      if (showComparison && prev && prev.dataUri) {
        const prevBox = document.createElement('div');
        prevBox.className = 'figure-box faded';
        const prevLabel = document.createElement('div');
        prevLabel.className = 'figure-box-label';
        prevLabel.textContent = 'Previous Run';
        const prevImg = document.createElement('img');
        prevImg.src = prev.dataUri;
        prevBox.appendChild(prevLabel);
        prevBox.appendChild(prevImg);
        imagesRow.appendChild(prevBox);
      }

      if (curr && curr.dataUri) {
        const currBox = document.createElement('div');
        currBox.className = 'figure-box';
        const currLabel = document.createElement('div');
        currLabel.className = 'figure-box-label';
        currLabel.textContent = showComparison ? 'Current Run' : '';
        const currImg = document.createElement('img');
        currImg.src = curr.dataUri;
        currBox.appendChild(currLabel);
        currBox.appendChild(currImg);
        imagesRow.appendChild(currBox);
      }

      card.appendChild(imagesRow);
      container.appendChild(card);
    }
  }
})();
