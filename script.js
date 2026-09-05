const navToggle = document.getElementById('navToggle');
const mainNav = document.getElementById('mainNav');

navToggle.addEventListener('click', () => {
  mainNav.classList.toggle('open');
});

mainNav.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => mainNav.classList.remove('open'));
});

document.querySelectorAll('.detail-toggle').forEach((button) => {
  button.addEventListener('click', () => {
    const detailRow = button.closest('tr').nextElementSibling;
    const isOpen = !detailRow.hidden;
    detailRow.hidden = isOpen;
    button.textContent = isOpen ? '詳細を見る' : '詳細を閉じる';
  });
});
