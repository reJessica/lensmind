package com.example.lensmind.vision;

import ai.onnxruntime.OnnxJavaType;
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;

import java.awt.image.BufferedImage;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;

@Component
class PersonDetector {
    private static final float MIN_CONFIDENCE = 0.45f;
    private static final int MAX_PEOPLE = 8;
    private final Path model;
    private final ReentrantLock lock = new ReentrantLock();
    private OrtSession session;

    PersonDetector(@Value("${lensmind.vision.model}") String model) {
        this.model = Path.of(model).toAbsolutePath();
    }

    // 同一时间推理一帧，让多个标签页同时打开时不会积压过时画面。
    List<Person> detect(BufferedImage frame) {
        if (!lock.tryLock()) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "视觉服务忙，请使用下一帧。");
        }
        try {
            if (session == null && !Files.isRegularFile(model)) {
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "人物模型未安装，请按启动说明准备模型。");
            }
            OrtEnvironment environment = OrtEnvironment.getEnvironment();
            if (session == null) {
                try (OrtSession.SessionOptions options = new OrtSession.SessionOptions()) {
                    options.setIntraOpNumThreads(2);
                    options.setInterOpNumThreads(1);
                    session = environment.createSession(model.toString(), options);
                }
            }
            int width = frame.getWidth();
            int height = frame.getHeight();
            ByteBuffer rgb = ByteBuffer.allocateDirect(width * height * 3);
            for (int pixel : frame.getRGB(0, 0, width, height, null, 0, width)) {
                rgb.put((byte) (pixel >> 16)).put((byte) (pixel >> 8)).put((byte) pixel);
            }
            rgb.flip();
            try (OnnxTensor input = OnnxTensor.createTensor(environment, rgb,
                    new long[]{1, height, width, 3}, OnnxJavaType.UINT8);
                 OrtSession.Result result = session.run(Map.of("inputs", input))) {
                float[][] boxes = ((float[][][]) result.get("detection_boxes").orElseThrow().getValue())[0];
                float[] scores = ((float[][]) result.get("detection_scores").orElseThrow().getValue())[0];
                float[] classes = ((float[][]) result.get("detection_classes").orElseThrow().getValue())[0];
                return detectedPeople(boxes, scores, classes);
            }
        } catch (OrtException | LinkageError error) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,
                    "人物检测暂不可用，请检查模型文件和本机运行环境。", error);
        } finally {
            lock.unlock();
        }
    }

    private static List<Person> detectedPeople(float[][] boxes, float[] scores, float[] classes) {
        List<Person> people = new ArrayList<>();
        for (int i = 0; i < Math.min(boxes.length, Math.min(scores.length, classes.length)); i++) {
            if (classes[i] != 1 || !Float.isFinite(scores[i]) || scores[i] < MIN_CONFIDENCE) continue;
            float[] box = boxes[i];
            double x = clamp(box[1]);
            double y = clamp(box[0]);
            double width = clamp(box[3]) - x;
            double height = clamp(box[2]) - y;
            if (!(width > 0 && height > 0)) continue;
            people.add(new Person(x, y, width, height, scores[i]));
        }
        return people.stream().sorted(Comparator.comparingDouble(Person::confidence).reversed())
                .limit(MAX_PEOPLE).toList();
    }

    private static double clamp(float value) {
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

    record Person(double x, double y, double width, double height, double confidence) {}
}
