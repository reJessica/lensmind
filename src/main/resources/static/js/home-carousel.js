const carousel = document.getElementById('home-carousel');

if (carousel) {
  const shots = [...carousel.querySelectorAll('.home-shot')];
  const status = document.getElementById('home-carousel-status');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const positions = ['active', 'next', 'back', 'previous'];
  let active = 0;
  let lastChange = -Infinity;

  function select(index, focusCurrent = false) {
    const now = performance.now();
    if (!reduceMotion.matches && now - lastChange < 650) return;
    lastChange = now;
    active = (index + shots.length) % shots.length;
    const current = shots[active];
    carousel.dataset.tone = current.dataset.tone;

    shots.forEach((shot, i) => {
      const position = positions[(i - active + shots.length) % shots.length];
      shot.dataset.position = position;
      shot.tabIndex = position === 'back' ? -1 : 0;
      shot.toggleAttribute('inert', position === 'back');
      if (position === 'back') shot.setAttribute('aria-hidden', 'true');
      else shot.removeAttribute('aria-hidden');
      const name = shot.dataset.person;
      shot.setAttribute('aria-label', position === 'active' ? '当前是' + name + '，点按切换下一位' : '切换到' + name);
    });
    status.textContent = current.dataset.person + '，第 ' + (active + 1) + ' 位，共 ' + shots.length + ' 位';

    if (focusCurrent) current.focus({ preventScroll: true });
  }

  shots.forEach((shot, index) => {
    shot.addEventListener('click', event => select(index === active ? active + 1 : index, event.detail === 0));
  });
  carousel.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    select(active + step, shots.includes(document.activeElement));
  });
}
