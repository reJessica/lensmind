package com.example.lensmind.vision;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.awt.image.BufferedImage;
import java.nio.FloatBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;

@Component
class FaceDetector {
    private static final int[] STRIDES = {8, 16, 32};
    private static final Set<String> OUTPUTS = Set.of("cls_8", "obj_8", "bbox_8", "cls_16", "obj_16", "bbox_16", "cls_32", "obj_32", "bbox_32");
    private final Path model;
    private final ReentrantLock lock = new ReentrantLock();
    private OrtSession session;

    FaceDetector(@Value("${lensmind.vision.face-model}") String model) {
        this.model = Path.of(model).toAbsolutePath();
    }

    // null 表示本帧未能运行模型；空列表表示运行成功但画面中没有可识别的脸。
    List<Face> detect(BufferedImage frame) {
        if (!lock.tryLock()) return null;
        try {
            OrtEnvironment environment = OrtEnvironment.getEnvironment();
            if (session == null) {
                if (!Files.isRegularFile(model)) return null;
                try (var options = new OrtSession.SessionOptions()) {
                    options.setIntraOpNumThreads(2);
                    options.setInterOpNumThreads(1);
                    session = environment.createSession(model.toString(), options);
                }
            }
            int width = frame.getWidth();
            int height = frame.getHeight();
            int paddedWidth = (width + 31) / 32 * 32;
            int paddedHeight = (height + 31) / 32 * 32;
            int plane = paddedWidth * paddedHeight;
            float[] bgr = new float[plane * 3];
            int[] rgb = frame.getRGB(0, 0, width, height, null, 0, width);
            for (int y = 0; y < height; y++) {
                for (int x = 0; x < width; x++) {
                    int pixel = rgb[y * width + x];
                    int offset = y * paddedWidth + x;
                    bgr[offset] = pixel & 255;
                    bgr[plane + offset] = (pixel >> 8) & 255;
                    bgr[plane * 2 + offset] = (pixel >> 16) & 255;
                }
            }
            try (var input = OnnxTensor.createTensor(environment, FloatBuffer.wrap(bgr), new long[]{1, 3, paddedHeight, paddedWidth});
                 var result = session.run(Map.of("input", input), OUTPUTS)) {
                var faces = new ArrayList<Face>();
                for (int stride : STRIDES) {
                    decode(faces, values(result, "cls_" + stride), values(result, "obj_" + stride),
                            values(result, "bbox_" + stride), stride, paddedWidth / stride, width, height);
                }
                return suppressDuplicates(faces);
            }
        } catch (OrtException | LinkageError error) {
            return null;
        } finally {
            lock.unlock();
        }
    }

    private static float[][] values(OrtSession.Result result, String name) throws OrtException {
        return ((float[][][]) result.get(name).orElseThrow().getValue())[0];
    }

    // YuNet 的每个网格位置输出分类分数、目标分数和边框偏移。
    private static void decode(List<Face> faces, float[][] classes, float[][] objects, float[][] boxes,
                               int stride, int columns, int width, int height) {
        for (int i = 0; i < classes.length; i++) {
            double score = Math.sqrt(clamp(classes[i][0]) * clamp(objects[i][0]));
            if (!(score >= .70)) continue;
            double cx = (i % columns + boxes[i][0]) * stride / width;
            double cy = (i / columns + boxes[i][1]) * stride / height;
            if (!(cx >= 0 && cx <= 1 && cy >= 0 && cy <= 1)) continue;
            double halfWidth = Math.exp(boxes[i][2]) * stride / width / 2;
            double halfHeight = Math.exp(boxes[i][3]) * stride / height / 2;
            double x = clamp(cx - halfWidth);
            double y = clamp(cy - halfHeight);
            double w = clamp(cx + halfWidth) - x;
            double h = clamp(cy + halfHeight) - y;
            if (w > 0 && h > 0) faces.add(new Face(x, y, w, h, score));
        }
    }

    private static List<Face> suppressDuplicates(List<Face> candidates) {
        candidates.sort(Comparator.comparingDouble(Face::confidence).reversed());
        var faces = new ArrayList<Face>();
        for (Face candidate : candidates) {
            if (faces.stream().noneMatch(face -> overlap(face, candidate) > .30)) faces.add(candidate);
            if (faces.size() == 8) break;
        }
        return faces;
    }

    private static double overlap(Face a, Face b) {
        double w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
        double h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        double intersection = w * h;
        return intersection / (a.width * a.height + b.width * b.height - intersection);
    }

    private static double clamp(double value) {
        return Math.max(0, Math.min(1, value));
    }

    @PreDestroy
    void close() throws OrtException {
        lock.lock();
        try {
            if (session != null) session.close();
        } finally {
            lock.unlock();
        }
    }

    record Face(double x, double y, double width, double height, double confidence) {}
}
