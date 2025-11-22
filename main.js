/**
 * MPOS-CORE – PRINTER AGENT
 * Respuestas estandarizadas con códigos semánticos.
 */

const { app, BrowserWindow, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const usb = require("usb");
const ReceiptPrinterEncoder = require("@point-of-sale/receipt-printer-encoder");

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
// USB HELPERS
// ====================================
function getDeviceInfo(device) {
  return new Promise((resolve) => {
    const desc = device.deviceDescriptor;

    const result = {
      vendorId: desc.idVendor,
      productId: desc.idProduct,
      manufacturer: null,
      product: null,
      serial: null,
    };

    let pending = 0;

    function readString(idx, key) {
      if (!idx) return;
      pending++;
      device.getStringDescriptor(idx, (err, txt) => {
        result[key] = err ? null : txt;
        pending--;
        if (pending === 0) resolve(result);
      });
    }

    readString(desc.iManufacturer, "manufacturer");
    readString(desc.iProduct, "product");
    readString(desc.iSerialNumber, "serial");

    if (pending === 0) resolve(result);
  });
}

async function findDeviceByIds(vendorId, productId) {
  const devices = usb.getDeviceList();
  return devices.find(
    (d) =>
      d.deviceDescriptor.idVendor === vendorId &&
      d.deviceDescriptor.idProduct === productId
  );
}

async function findThermalPrinter() {
  const devices = usb.getDeviceList();
  for (const d of devices) {
    try {
      d.open();
    } catch {
      continue;
    }

    const info = await getDeviceInfo(d);
    d.close();

    const manu = (info.manufacturer || "").toLowerCase();
    const prod = (info.product || "").toLowerCase();

    const isPrinter =
      manu.includes("epson") ||
      manu.includes("rongta") ||
      manu.includes("bixolon") ||
      manu.includes("star") ||
      manu.includes("printer") ||
      manu.includes("xprinter") ||
      manu.includes("zjiang") ||
      manu.includes("custom") ||
      manu.includes("sunmi") ||
      prod.includes("printer") ||
      prod.includes("receipt") ||
      prod.includes("pos");

    if (isPrinter) return d;
  }

  return null;
}

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
      if (process.platform === "darwin") {
        app.dock.hide();
      }
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

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Abrir Mart POS Core",
      click: showWindow,
    },
    { type: "separator" },
    {
      label: "Salir",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on("click", () => {
    if (!mainWindow) {
      showWindow();
      return;
    }

    if (mainWindow.isVisible()) {
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
    const { vendorId, productId } = req.body;

    if (!vendorId || !productId) {
      return res.json({ ok: false, code: "DEFAULT_PRINTER_INVALID" });
    }

    defaultPrinter = { vendorId, productId };

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
      const devices = usb.getDeviceList();
      const list = [];

      for (const d of devices) {
        let info = null;

        try {
          d.open();
          info = await getDeviceInfo(d);
          d.close();
        } catch {
          continue;
        }

        const iface = d.interfaces?.[0];
        const ifaceClass = iface?.descriptor?.bInterfaceClass ?? null;

        const manu = (info.manufacturer || "").toLowerCase();
        const prod = (info.product || "").toLowerCase();

        const isThermal =
          manu.includes("epson") ||
          manu.includes("rongta") ||
          manu.includes("bixolon") ||
          manu.includes("star") ||
          manu.includes("printer") ||
          prod.includes("printer") ||
          prod.includes("receipt") ||
          prod.includes("pos") ||
          manu.includes("custom") ||
          manu.includes("sunmi") ||
          ifaceClass === 7 ||
          ifaceClass === 255;

        list.push({
          ...info,
          busNumber: d.busNumber,
          deviceAddress: d.deviceAddress,
          interfaceClass: ifaceClass,
          isThermalPrinter: isThermal,
        });

        console.log(devices, list);
      }

      if (list.length === 0) {
        return res.json({
          ok: true,
          printers: [],
          code: "PRINTER_LIST_EMPTY",
        });
      }

      res.json({
        ok: true,
        printers: list,
        code: "PRINTER_LIST_OK",
      });
    } catch {
      res.json({ ok: false, code: "USB_ACCESS_DENIED" });
    }
  });

  // -----------------------------
  // PRINT TEST
  // -----------------------------
  api.get("/print-test", async (_, res) => {
    if (!agentEnabled) return res.json({ ok: false, code: "AGENT_OFF" });

    let device = null;

    if (defaultPrinter) {
      device = await findDeviceByIds(
        defaultPrinter.vendorId,
        defaultPrinter.productId
      );
    }

    if (!device) device = await findThermalPrinter();
    if (!device)
      return res.json({ ok: false, code: "THERMAL_PRINTER_NOT_FOUND" });

    device.open();

    const iface = device.interfaces[0];
    try {
      if (iface.isKernelDriverActive()) iface.detachKernelDriver();
    } catch {}

    iface.claim();

    const out = iface.endpoints.find((e) => e.direction === "out");
    if (!out)
      return res.json({ ok: false, code: "USB_OUT_ENDPOINT_NOT_FOUND" });

    const encoder = new ReceiptPrinterEncoder({ encoding: "UTF-8", width: 48 });

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

    out.transfer(Buffer.from(data), (err) => {
      device.close();
      if (err) return res.json({ ok: false, code: "PRINT_TEST_ERROR" });

      res.json({ ok: true, code: "PRINT_TEST_OK" });
    });
  });

  // =======================
  // BARCODE + QR CONFIG
  // =======================
  function addBarcodeAndQR(t, sale, store, locale) {
    // Texto que acompañará
    const url = `https://martpos.app/invoice/${sale.id}`;

    // ----- BARCODE -----
    t = t
      .newline()
      .align("center")
      .bold(true)
      .line("Barcode")
      .bold(false)
      .barcode(sale.number || "123456789", "code128", { height: 60 });

    // ----- QR CODE -----
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
      let device = null;

      if (defaultPrinter) {
        device = await findDeviceByIds(
          defaultPrinter.vendorId,
          defaultPrinter.productId
        );
      }

      if (!device) device = await findThermalPrinter();
      if (!device)
        return res.json({ ok: false, code: "THERMAL_PRINTER_NOT_FOUND" });

      device.open();
      const iface = device.interfaces[0];

      try {
        if (iface.isKernelDriverActive()) iface.detachKernelDriver();
      } catch {}

      iface.claim();
      const out = iface.endpoints.find((e) => e.direction === "out");
      if (!out)
        return res.json({ ok: false, code: "USB_OUT_ENDPOINT_NOT_FOUND" });

      const enc = new ReceiptPrinterEncoder({ encoding: "UTF-8", width: 48 });
      const line = "-".repeat(48);

      // HEADER
      let t = enc.initialize();

      t = t.align("center");
      t.line("").bold(true);
      if (store?.address) t = t.line(store?.name).bold(false);
      if (store?.address) t = t.line(store.address).bold(false);
      if (store?.phone) t = t.line(`Tel: ${store.phone}`).bold(false);

      // Ahora SÍ vuelvo a la izquierda
      t = t.align("left");

      // INFO
      t = t
        .newline()
        .align("left")
        .bold(false)
        .line(line)
        .line(`${lang.invoice}: ${sale.id}`)
        .line(`${lang.date}: ${new Date(sale.date).toLocaleString(locale)}`);

      if (employee?.name) t = t.line(`${lang.seller}: ${employee.name}`);

      t = t.line(line).newline();

      // TABLE HEADER
      t = t
        .bold(true)
        .line(
          `${lang.product.padEnd(22)}${lang.qty.padStart(
            4
          )}${lang.price.padStart(10)}${lang.total.padStart(10)}`
        );
      t = t.bold(false);

      // ==========================
      // ITEMS
      // ==========================
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

      // TOTALS
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

      // PAYMENT METHOD
      if (sale.payment_method) {
        t = t
          .align("center")
          .line(`${lang.payment_method}: ${sale.payment_method}`);
      }

      // BARCODE + QR
      t = addBarcodeAndQR(t, sale, store, locale);

      // FOOTER
      t = t
        .newline()
        .align("center")
        .bold(true)
        .line(lang.thanks)
        .bold(false)
        .line("")
        .line("Powered by martpos.app")
        .bold(false)
        .newline(3)
        .cut("partial");

      const buffer = Buffer.from(t.encode());

      out.transfer(buffer, (err) => {
        device.close();
        if (err) return res.json({ ok: false, code: "PRINT_SALE_ERROR" });
        res.json({ ok: true, code: "PRINT_SALE_OK" });
      });
    } catch (e) {
      res.json({ ok: false, code: "PRINT_SALE_ERROR" });
    }
  });

  // Finalmente: levantar servidor
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
