// Runs inside the Glovo portal page. When the page builds the report file itself (a blob), its text goes to relay.js.
(() => {
  const make = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = make.apply(this, arguments);
    if (obj instanceof Blob && obj.size < 20e6) {
      obj.text().then((csv) => {
        const head = csv.slice(0, 2000);
        if (/замовлен|order/i.test(head) && /відгук|review/i.test(head)) window.postMessage({ kebabtsiaGlovo: true, csv }, location.origin);
      }).catch(() => {});
    }
    return url;
  };
})();
