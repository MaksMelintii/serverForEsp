import express from "express";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";
import pg from "pg";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

dotenv.config();

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = process.env.UPLOAD_DIR || "uploads";

const USE_S3 = process.env.STORAGE_TYPE === "s3";

const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME;
const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_REGION = process.env.S3_REGION || "auto";
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY;

let s3 = null;

if (USE_S3) {
  s3 = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    credentials: {
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY
    },
    forcePathStyle: true
  });

  console.log("Storage mode: S3 Bucket");
} else {
  console.log("Storage mode: Local uploads");
}

// Створюємо папку для фото, якщо її нема
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Підключення до PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

app.get("/api/photos/file/:fileName", async (req, res) => {
  try {
    if (!USE_S3) {
      return res.status(400).json({
        success: false,
        message: "S3 storage is not enabled"
      });
    }

    const { fileName } = req.params;

    const command = new GetObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: fileName
    });

    const signedUrl = await getSignedUrl(s3, command, {
      expiresIn: 60 * 10
    });

    res.redirect(signedUrl);
  } catch (error) {
    console.error("GET PHOTO FILE ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Помилка отримання фото",
      error: error.message
    });
  }
});

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Статичні файли
// /uploads/photo.jpg
app.use("/uploads", express.static(UPLOAD_DIR));

// public/index.html буде відкриватися на http://localhost:3000/
app.use(express.static("public"));

// Налаштування multer для завантаження фото
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 12 * 1024 * 1024 // 12 MB
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Можна завантажувати тільки картинки"));
    }

    cb(null, true);
  }
});

function getBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

// Два пристрої
const DEVICES = {
  maksymka: {
    deviceCode: "maksymka_frame",
    name: "Максімка",
    secret: "maks_secret"
  },
  alinka: {
    deviceCode: "alinka_frame",
    name: "Алінка",
    secret: "alina_secret"
  }
};

// ===============================
// API: перевірка сервера
// ===============================
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "ESP Photo Frame Server працює"
  });
});

// ===============================
// API: створення таблиць
// ===============================
app.get("/api/setup", async (req, res) => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id SERIAL PRIMARY KEY,
        device_code VARCHAR(100) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        secret VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS photos (
        id SERIAL PRIMARY KEY,
        to_device_code VARCHAR(100) NOT NULL,
        recipient_name VARCHAR(100) NOT NULL,
        image_url TEXT NOT NULL,
        original_name TEXT,
        seen BOOLEAN DEFAULT FALSE,
        seen_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    res.json({
      success: true,
      message: "Таблиці devices і photos створено"
    });
  } catch (error) {
    console.error("SETUP ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Помилка створення таблиць",
      error: error.message
    });
  }
});

// ===============================
// API: віддає фото вже як RGB565 800x480
// ===============================

app.get("/api/devices/:deviceCode/photos/:photoId/raw", async (req, res) => {
  try {
    const { deviceCode, photoId } = req.params;
    const { secret } = req.query;

    if (!secret) {
      return res.status(400).json({
        success: false,
        message: "secret обовʼязковий"
      });
    }

    const deviceResult = await pool.query(
      "SELECT * FROM devices WHERE device_code = $1",
      [deviceCode]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Пристрій не знайдено"
      });
    }

    const device = deviceResult.rows[0];

    if (device.secret !== secret) {
      return res.status(403).json({
        success: false,
        message: "Невірний secret"
      });
    }

    const photoResult = await pool.query(
      `
      SELECT *
      FROM photos
      WHERE id = $1
        AND to_device_code = $2
      `,
      [photoId, deviceCode]
    );

    if (photoResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Фото не знайдено"
      });
    }

    const photo = photoResult.rows[0];

    const imageResponse = await fetch(photo.image_url);
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());

    const rgbBuffer = await sharp(imageBuffer)
      .rotate()
      .resize(480, 800, {
        fit: "cover",
        position: "center"
      })
      .removeAlpha()
      .raw()
      .toBuffer();

    const rgb565Buffer = Buffer.alloc(480 * 800 * 2);

    for (let i = 0, j = 0; i < rgbBuffer.length; i += 3, j += 2) {
      const r = rgbBuffer[i];
      const g = rgbBuffer[i + 1];
      const b = rgbBuffer[i + 2];

      const rgb565 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3);

      rgb565Buffer[j] = rgb565 & 0xFF;
      rgb565Buffer[j + 1] = (rgb565 >> 8) & 0xFF;
    }

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", rgb565Buffer.length);

    res.send(rgb565Buffer);

  } catch (error) {
    console.error("RAW PHOTO ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Помилка отримання RAW фото",
      error: error.message
    });
  }
});

// ===============================
// API: додати Максімку і Алінку
// ===============================
app.get("/api/seed", async (req, res) => {
  try {
    await pool.query(
      `
      INSERT INTO devices (device_code, name, secret)
      VALUES
        ($1, $2, $3),
        ($4, $5, $6)
      ON CONFLICT (device_code)
      DO UPDATE SET
        name = EXCLUDED.name,
        secret = EXCLUDED.secret;
      `,
      [
        DEVICES.maksymka.deviceCode,
        DEVICES.maksymka.name,
        DEVICES.maksymka.secret,

        DEVICES.alinka.deviceCode,
        DEVICES.alinka.name,
        DEVICES.alinka.secret
      ]
    );

    res.json({
      success: true,
      message: "Пристрої Максімки і Алінки додано",
      devices: [
        {
          name: DEVICES.maksymka.name,
          deviceCode: DEVICES.maksymka.deviceCode,
          secret: DEVICES.maksymka.secret
        },
        {
          name: DEVICES.alinka.name,
          deviceCode: DEVICES.alinka.deviceCode,
          secret: DEVICES.alinka.secret
        }
      ]
    });
  } catch (error) {
    console.error("SEED ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Помилка додавання пристроїв",
      error: error.message
    });
  }
});

// ===============================
// API: список пристроїв
// ===============================
app.get("/api/devices", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, device_code, name, created_at
      FROM devices
      ORDER BY id ASC
    `);

    res.json({
      success: true,
      devices: result.rows
    });
  } catch (error) {
    console.error("DEVICES ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Помилка отримання пристроїв",
      error: error.message
    });
  }
});

async function savePhotoFile(buffer, fileName, req) {
  const processedImageBuffer = await sharp(buffer)
    .rotate()
    .resize(480, 800, {
      fit: "inside",
      withoutEnlargement: true,
      background: {
        r: 0,
        g: 0,
        b: 0,
        alpha: 1
      }
    })
    .jpeg({
      quality: 88
    })
    .toBuffer();

  if (USE_S3) {
    await s3.send(
      new PutObjectCommand({
        Bucket: S3_BUCKET_NAME,
        Key: fileName,
        Body: processedImageBuffer,
        ContentType: "image/jpeg"
      })
    );

    return `${getBaseUrl(req)}/api/photos/file/${fileName}`;
  }

  const filePath = path.join(UPLOAD_DIR, fileName);
  fs.writeFileSync(filePath, processedImageBuffer);

  return `${getBaseUrl(req)}/uploads/${fileName}`;
}

// ===============================
// API: відправити фото з сайту
// recipient: maksymka або alinka
// ===============================
app.post("/api/photos/send", upload.single("photo"), async (req, res) => {
  try {
    const { recipient } = req.body;

    if (!recipient) {
      return res.status(400).json({
        success: false,
        message: "Вибери, кому відправити фото"
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Фото не вибрано"
      });
    }

    const selectedDevice = DEVICES[recipient];

    if (!selectedDevice) {
      return res.status(400).json({
        success: false,
        message: "Невідомий отримувач"
      });
    }

    const deviceResult = await pool.query(
      "SELECT * FROM devices WHERE device_code = $1",
      [selectedDevice.deviceCode]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Пристрій не знайдено. Спочатку відкрий /api/setup і /api/seed"
      });
    }

    const safeName = recipient === "maksymka" ? "maksymka" : "alinka";
    const fileName = `${Date.now()}-${safeName}.jpg`;

    const imageUrl = await savePhotoFile(
      req.file.buffer,
      fileName,
      req
    );

    const photoResult = await pool.query(
      `
      INSERT INTO photos (
        to_device_code,
        recipient_name,
        image_url,
        original_name,
        seen
      )
      VALUES ($1, $2, $3, $4, false)
      RETURNING *
      `,
      [
        selectedDevice.deviceCode,
        selectedDevice.name,
        imageUrl,
        req.file.originalname
      ]
    );

    res.json({
      success: true,
      message: `Фото відправлено для ${selectedDevice.name}`,
      photo: photoResult.rows[0]
    });
  } catch (error) {
    console.error("SEND PHOTO ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Помилка відправки фото",
      error: error.message
    });
  }
});

// ===============================
// API для ESP:
// ESP питає, чи є нове фото
// ===============================
app.get("/api/devices/:deviceCode/latest-photo", async (req, res) => {
  try {
    const { deviceCode } = req.params;
    const { secret } = req.query;

    if (!secret) {
      return res.status(400).json({
        success: false,
        message: "secret обовʼязковий"
      });
    }

    const deviceResult = await pool.query(
      "SELECT * FROM devices WHERE device_code = $1",
      [deviceCode]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Пристрій не знайдено"
      });
    }

    const device = deviceResult.rows[0];

    if (device.secret !== secret) {
      return res.status(403).json({
        success: false,
        message: "Невірний secret"
      });
    }

    const photoResult = await pool.query(
      `
      SELECT *
      FROM photos
      WHERE to_device_code = $1
        AND seen = false
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [deviceCode]
    );

    if (photoResult.rows.length === 0) {
      return res.json({
        success: true,
        hasPhoto: false
      });
    }

    const photo = photoResult.rows[0];

    res.json({
      success: true,
      hasPhoto: true,
      photo: {
        id: photo.id,
        url: photo.image_url,
        recipientName: photo.recipient_name,
        seen: photo.seen,
        createdAt: photo.created_at
      }
    });
  } catch (error) {
    console.error("LATEST PHOTO ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Помилка отримання фото",
      error: error.message
    });
  }
});

// ===============================
// API для ESP:
// ESP каже, що фото показано
// ===============================
app.post("/api/devices/:deviceCode/photos/:photoId/seen", async (req, res) => {
  try {
    const { deviceCode, photoId } = req.params;
    const { secret } = req.body;

    if (!secret) {
      return res.status(400).json({
        success: false,
        message: "secret обовʼязковий"
      });
    }

    const deviceResult = await pool.query(
      "SELECT * FROM devices WHERE device_code = $1",
      [deviceCode]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Пристрій не знайдено"
      });
    }

    const device = deviceResult.rows[0];

    if (device.secret !== secret) {
      return res.status(403).json({
        success: false,
        message: "Невірний secret"
      });
    }

    const photoResult = await pool.query(
      `
      UPDATE photos
      SET seen = true,
          seen_at = NOW()
      WHERE id = $1
        AND to_device_code = $2
      RETURNING *
      `,
      [photoId, deviceCode]
    );

    if (photoResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Фото не знайдено"
      });
    }

    res.json({
      success: true,
      message: "Фото позначено як переглянуте",
      photo: photoResult.rows[0]
    });
  } catch (error) {
    console.error("SEEN PHOTO ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Помилка оновлення статусу фото",
      error: error.message
    });
  }
});

// ===============================
// API: історія всіх фото для UI
// ===============================
app.get("/api/photos", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM photos
      ORDER BY created_at DESC
      LIMIT 50
    `);

    res.json({
      success: true,
      photos: result.rows
    });
  } catch (error) {
    console.error("PHOTOS ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Помилка отримання фото",
      error: error.message
    });
  }
});

// ===============================
// API для ESP/UI:
// історія фото конкретного пристрою
// ===============================
app.get("/api/devices/:deviceCode/photos", async (req, res) => {
  try {
    const { deviceCode } = req.params;
    const { secret } = req.query;

    if (!secret) {
      return res.status(400).json({
        success: false,
        message: "secret обовʼязковий"
      });
    }

    const deviceResult = await pool.query(
      "SELECT * FROM devices WHERE device_code = $1",
      [deviceCode]
    );

    if (deviceResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Пристрій не знайдено"
      });
    }

    const device = deviceResult.rows[0];

    if (device.secret !== secret) {
      return res.status(403).json({
        success: false,
        message: "Невірний secret"
      });
    }

    const result = await pool.query(
      `
      SELECT *
      FROM photos
      WHERE to_device_code = $1
      ORDER BY created_at DESC
      LIMIT 50
      `,
      [deviceCode]
    );

    res.json({
      success: true,
      photos: result.rows
    });
  } catch (error) {
    console.error("DEVICE PHOTOS ERROR:", error);

    res.status(500).json({
      success: false,
      message: "Помилка отримання історії",
      error: error.message
    });
  }
});

// ===============================
// Обробка помилок multer/file upload
// ===============================
app.use((error, req, res, next) => {
  console.error("GLOBAL ERROR:", error);

  if (error instanceof multer.MulterError) {
    return res.status(400).json({
      success: false,
      message: "Помилка завантаження файлу",
      error: error.message
    });
  }

  res.status(500).json({
    success: false,
    message: "Помилка сервера",
    error: error.message
  });
});

// ===============================
// Запуск сервера
// ===============================
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});