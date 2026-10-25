// Wear comparte el carrito existente; este primer paso solo lo lee.
// No añade productos sin precio/opciones/stock confirmados, ni cambia pedidos.
(() => {
  'use strict';
  const key = 'encantelia_cart_v1';
  function updateCartCount() {
    let count = 0;
    try {
      const data = JSON.parse(localStorage.getItem(key) || 'null');
      if (data && data.v === 1 && Array.isArray(data.items)) {
        count = data.items.reduce((sum, item) => {
          if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') return sum;
          if (item.priced && (!item.config || !item.config.productId || !Number.isInteger(item.qty))) return sum;
          const qty = Number.isInteger(item.qty) && item.qty > 0 ? item.qty : (item.priced ? 0 : 1);
          return sum + qty;
        }, 0);
      }
    } catch (_) { /* Carrito vacío o almacenamiento no disponible. */ }
    const badge = document.getElementById('wearCartCount');
    if (badge) badge.textContent = String(count);
  }
  updateCartCount();
  window.addEventListener('storage', e => { if (e.key === key || e.key === null) updateCartCount(); });
  window.addEventListener('pageshow', updateCartCount);
})();
