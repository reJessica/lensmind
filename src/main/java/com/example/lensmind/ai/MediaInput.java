package com.example.lensmind.ai;

import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.*;
import java.util.Base64;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import javax.sound.sampled.*;

public final class MediaInput {
    private MediaInput() {}
    public record Image(String dataUrl, int width, int height) {}
    public static Image image(byte[] bytes) {
        if (bytes.length == 0 || bytes.length > 4_000_000) throw AiException.badInput("图片必须为 JPEG/PNG，且不超过 4 MB");
        try (ImageInputStream input = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            var readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) throw AiException.badInput("无法识别图片，请使用 JPEG 或 PNG");
            ImageReader reader = readers.next();
            try {
                reader.setInput(input, true, true);
                String format = reader.getFormatName();
                if (!(format.equalsIgnoreCase("JPEG") || format.equalsIgnoreCase("PNG"))) throw AiException.badInput("只支持 JPEG 或 PNG");
                int w = reader.getWidth(0), h = reader.getHeight(0);
                if (w <= 0 || h <= 0 || w > 4096 || h > 4096 || (long) w * h > 12_000_000) {
                    throw AiException.badInput("图片边长不得超过 4096，像素总数不得超过 1200 万");
                }
                BufferedImage source = reader.read(0);
                double scale = Math.min(1.0, 1024.0 / Math.max(w, h));
                BufferedImage small = new BufferedImage(Math.max(1, (int)(w * scale)), Math.max(1, (int)(h * scale)), BufferedImage.TYPE_INT_RGB);
                Graphics2D g = small.createGraphics();
                g.setColor(java.awt.Color.WHITE); g.fillRect(0, 0, small.getWidth(), small.getHeight());
                g.drawImage(source, 0, 0, small.getWidth(), small.getHeight(), null); g.dispose();
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                ImageIO.write(small, "jpg", out);
                return new Image("data:image/jpeg;base64," + Base64.getEncoder().encodeToString(out.toByteArray()), w, h);
            } finally { reader.dispose(); }
        } catch (AiException e) { throw e; }
        catch (Exception e) { throw AiException.badInput("图片解码失败，请检查文件是否完整"); }
    }
    public static String wav(byte[] bytes) {
        if (bytes.length < 44 || bytes.length > 3_000_000) throw AiException.badInput("录音必须为 1～15 秒的 PCM WAV，且不超过 3 MB");
        if (!(bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == 'F'
                && bytes[8] == 'W' && bytes[9] == 'A' && bytes[10] == 'V' && bytes[11] == 'E')) throw AiException.badInput("当前接口仅接收 PCM WAV，请勿把 WebM 改后缀上传");
        try (AudioInputStream stream = AudioSystem.getAudioInputStream(new ByteArrayInputStream(bytes))) {
            AudioFormat f = stream.getFormat();
            double seconds = stream.getFrameLength() / f.getFrameRate();
            if (!AudioFormat.Encoding.PCM_SIGNED.equals(f.getEncoding()) || f.getSampleSizeInBits() != 16
                    || f.getChannels() < 1 || f.getChannels() > 2 || f.getSampleRate() < 8000 || f.getSampleRate() > 48000
                    || !Double.isFinite(seconds) || seconds < .1 || seconds > 15) throw AiException.badInput("录音需为 0.1～15 秒、8～48 kHz、16-bit PCM WAV（建议单声道 16 kHz）");
            return "data:audio/wav;base64," + Base64.getEncoder().encodeToString(bytes);
        } catch (AiException e) { throw e; }
        catch (Exception e) { throw AiException.badInput("无法解码 WAV 录音"); }
    }
    /** MOCK TTS 是提示音，绝不冒充真实语音。也可用于不含人声的协议测试。 */
    public static byte[] mockTone() {
        int sampleRate = 16000, count = 8000;
        java.nio.ByteBuffer b = java.nio.ByteBuffer.allocate(44 + count * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(36 + count * 2)
                .put("WAVEfmt ".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(16)
                .putShort((short)1).putShort((short)1).putInt(sampleRate).putInt(sampleRate * 2)
                .putShort((short)2).putShort((short)16).put("data".getBytes(java.nio.charset.StandardCharsets.US_ASCII)).putInt(count * 2);
        for (int i = 0; i < count; i++) b.putShort((short)(Math.sin(i * 2 * Math.PI * 440 / sampleRate) * 1200));
        return b.array();
    }
}
