/**
 * MPOS-CORE – PRINTER AGENT
 * Integración con @printers/printers usando require() + import dinámico.
 * API y códigos semánticos permanecen EXACTOS.
 */

const { app, BrowserWindow, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const ReceiptPrinterEncoder = require("@point-of-sale/receipt-printer-encoder");

// ============================================
// IMPORT DINÁMICO PARA @printers/printers
// ============================================
let printersLibPromise = import("@printers/printers"); // NO rompe require()

// ====================================
// CONFIG
// ====================================
let server = null;
let agentEnabled = true;
let defaultPrinter = null;
const SERVER_PORT = 3300;

let mainWindow = null;
let tray = null;
let isQuitting = false;

const i18n = {
  es: {
    invoice: "Factura",
    date: "Fecha",
    seller: "Vendedor",
    product: "Producto",
    qty: "Cant",
    price: "Precio",
    total: "Total",
    subtotal: "Subtotal",
    tax: "IVA",
    discount: "Descuento",
    grand_total: "TOTAL",
    thanks: "¡Gracias por su compra!",
    payment_method: "Método de pago",
  },
  en: {
    invoice: "Invoice",
    date: "Date",
    seller: "Seller",
    product: "Product",
    qty: "Qty",
    price: "Price",
    total: "Total",
    subtotal: "Subtotal",
    tax: "Tax",
    discount: "Discount",
    grand_total: "TOTAL",
    thanks: "Thank you for your purchase!",
    payment_method: "Payment method",
  },
};

// ====================================
// ELECTRON UI
// ====================================
function createWindow() {
  if (mainWindow) return;

  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: "#FFFFFF",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (process.platform === "darwin") app.dock.hide();
    }
  });
}

function createTray() {
  if (tray) return;

  const iconPath = path.join(__dirname, "icon.png");
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
  } catch {
    icon = undefined;
  }

  tray = new Tray(icon || undefined);
  tray.setToolTip("Mart POS Core");

  const showWindow = () => {
    if (!mainWindow) createWindow();
    mainWindow.show();
    if (process.platform === "darwin") app.dock.show();
  };

  const menu = Menu.buildFromTemplate([
    { label: "Abrir Mart POS Core", click: showWindow },
    { type: "separator" },
    {
      label: "Salir",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);

  tray.on("click", () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
      if (process.platform === "darwin") app.dock.hide();
    } else {
      showWindow();
    }
  });
}

// ====================================
// EXPRESS SERVER
// ====================================
function startLocalServer() {
  const api = express();
  api.use(bodyParser.json({ limit: "5mb" }));

  // CORS
  api.use((req, res, next) => {
    const allowed = [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://martpos.app",
      "https://app.martpos.app",
    ];

    const origin = req.headers.origin;
    res.header(
      "Access-Control-Allow-Origin",
      allowed.includes(origin) ? origin : "*"
    );
    res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") return res.sendStatus(200);

    next();
  });

  // -----------------------------
  // AGENT STATUS
  // -----------------------------
  api.get("/agent/status", (_, res) => {
    res.json({
      ok: true,
      enabled: agentEnabled,
      code: agentEnabled ? "AGENT_ON" : "AGENT_OFF",
    });
  });

  api.post("/agent/on", (_, res) => {
    agentEnabled = true;
    res.json({ ok: true, enabled: true, code: "AGENT_ON" });
  });

  api.post("/agent/off", (_, res) => {
    agentEnabled = false;
    res.json({ ok: true, enabled: false, code: "AGENT_OFF" });
  });

  // -----------------------------
  // DEFAULT PRINTER
  // -----------------------------
  api.get("/printer/default", (_, res) => {
    res.json({ ok: true, defaultPrinter, code: "DEFAULT_PRINTER_GET" });
  });

  api.post("/printer/default", (req, res) => {
    const { name } = req.body;

    if (!name) return res.json({ ok: false, code: "DEFAULT_PRINTER_INVALID" });

    defaultPrinter = { name };

    res.json({
      ok: true,
      defaultPrinter,
      code: "DEFAULT_PRINTER_SET",
    });
  });

  // -----------------------------
  // PRINTER LIST
  // -----------------------------
  api.get("/printers", async (_, res) => {
    try {
      const lib = await printersLibPromise;
      const printers = lib.getAllPrinters();

      const list = printers.map((p) => ({
        vendorId: null,
        productId: null,
        manufacturer: null,
        product: p.name,
        serial: null,
        busNumber: null,
        deviceAddress: null,
        interfaceClass: null,
        isThermalPrinter: true,
        name: p.name,
        isDefault: p.isDefault || false,
      }));

      res.json({
        ok: true,
        printers: list,
        code: "PRINTER_LIST_OK",
      });
    } catch (e) {
      res.json({ ok: false, printers: [], code: "PRINTER_LIST_ERROR" });
    }
  });

  // -----------------------------
  // PRINT TEST
  // -----------------------------
  api.get("/print-test", async (_, res) => {
    if (!agentEnabled) return res.json({ ok: false, code: "AGENT_OFF" });

    try {
      const lib = await printersLibPromise;
      const { getAllPrinters, getPrinterByName } = lib;

      const selected =
        defaultPrinter?.name || getAllPrinters().find((p) => p.isDefault)?.name;

      if (!selected)
        return res.json({ ok: false, code: "THERMAL_PRINTER_NOT_FOUND" });

      const printer = getPrinterByName(selected);

      const encoder = new ReceiptPrinterEncoder({
        encoding: "UTF-8",
        width: 48,
      });

      const data = encoder
        .initialize()
        .align("center")
        .bold(true)
        .size(2, 2)
        .line("MART POS")
        .bold(false)
        .align("left")
        .line("Ticket de prueba")
        .line("Ticket of proof")
        .newline(4)
        .cut("partial")
        .encode();

      await printer.printBytes(Buffer.from(data), { raw: {} });

      res.json({ ok: true, code: "PRINT_TEST_OK" });
    } catch (e) {
      res.json({ ok: false, code: "PRINT_TEST_ERROR" });
    }
  });

  // =======================
  // BARCODE + QR
  // =======================
  function addBarcodeAndQR(t, sale, store, locale) {
    const url = `https://martpos.app/invoice/${sale.id}`;

    t = t
      .newline()
      .align("center")
      .bold(true)
      .line("Barcode")
      .bold(false)
      .barcode(sale.number || "123456789", "code128", { height: 60 });

    t = t.align("center").bold(true).line("QR").bold(false);

    t = t.qrcode(url, {
      model: 1,
      size: 6,
      correction: "M",
    });

    return t;
  }

  // -----------------------------
  // PRINT SALE
  // -----------------------------
  api.post("/print-sale", async (req, res) => {
    if (!agentEnabled) return res.json({ ok: false, code: "AGENT_OFF" });

    const { sale, store, employee, items, locale = "en" } = req.body;
    const lang = i18n[locale] || i18n.es;

    try {
      const lib = await printersLibPromise;
      const { getAllPrinters, getPrinterByName } = lib;

      const selected =
        defaultPrinter?.name || getAllPrinters().find((p) => p.isDefault)?.name;

      if (!selected)
        return res.json({ ok: false, code: "THERMAL_PRINTER_NOT_FOUND" });

      const printer = getPrinterByName(selected);

      const enc = new ReceiptPrinterEncoder({ encoding: "UTF-8", width: 48 });
      const line = "-".repeat(48);
      let t = enc.initialize();

      // HEADER
      t = t.align("center");
      t.line("").bold(true);
      if (store?.address) t = t.line(store?.name).bold(false);
      if (store?.address) t = t.line(store.address).bold(false);
      if (store?.phone) t = t.line(`Tel: ${store.phone}`).bold(false);
      t = t.align("left");

      t = t
        .newline()
        .line(line)
        .line(`${lang.invoice}: ${sale.id}`)
        .line(`${lang.date}: ${new Date(sale.date).toLocaleString(locale)}`);

      if (employee?.name) t = t.line(`${lang.seller}: ${employee.name}`);

      t = t.line(line).newline();

      t = t
        .bold(true)
        .line(
          `${lang.product.padEnd(22)}${lang.qty.padStart(
            4
          )}${lang.price.padStart(10)}${lang.total.padStart(10)}`
        )
        .bold(false);

      items.forEach((item) => {
        const name = item.name.slice(0, 22).padEnd(22);
        const qty = String(item.quantity).padStart(4);
        const price = item.unit_price.toFixed(2).padStart(10);
        const total = (item.quantity * item.unit_price + item.tax)
          .toFixed(2)
          .padStart(10);

        t = t.line(`${name}${qty}${price}${total}`);
      });

      t = t.line(line);

      t = t
        .align("right")
        .line(`${lang.subtotal}: $${sale.subtotal.toFixed(2)}`)
        .line(`${lang.tax}: $${sale.tax_total.toFixed(2)}`)
        .line(`${lang.discount}: $${sale.discount_total.toFixed(2)}`)
        .bold(true)
        .size(2, 2)
        .line(`${lang.grand_total}: $${sale.grand_total.toFixed(2)}`)
        .bold(false)
        .size(1, 1)
        .align("left")
        .newline();

      if (sale.payment_method) {
        t = t
          .align("center")
          .line(`${lang.payment_method}: ${sale.payment_method}`);
      }

      t = addBarcodeAndQR(t, sale, store, locale);

      t = t
        .newline()
        .align("center")
        .bold(true)
        .line(lang.thanks)
        .bold(false)
        .line("Powered by martpos.app")
        .newline(3)
        .cut("partial");

      const buffer = Buffer.from(t.encode());

      await printer.printBytes(buffer, { raw: {} });

      res.json({ ok: true, code: "PRINT_SALE_OK" });
    } catch (e) {
      res.json({ ok: false, code: "PRINT_SALE_ERROR" });
    }
  });

  server = api.listen(SERVER_PORT, () => {
    console.log(`MPOS-Core API running on http://localhost:${SERVER_PORT}`);
  });
}

// ====================================
// APP LIFECYCLE
// ====================================
app.on("ready", () => {
  startLocalServer();
  createWindow();
  createTray();
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    if (server) server.close();
    app.quit();
  }
});

app.on("activate", () => {
  if (!mainWindow) {
    createWindow();
  } else {
    mainWindow.show();
    if (process.platform === "darwin") app.dock.show();
  }
});
