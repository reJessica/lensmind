package com.example.lensmind.vision;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.awt.RenderingHints;
import java.awt.geom.AffineTransform;
import java.awt.image.BufferedImage;
import java.nio.FloatBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;

/** OpenCV Zoo 的 MediaPipe 姿态模型，沿用现有人物检测框截取每个人的区域。 */
@Component
class PoseDetector {
    private static final int SIZE = 256;
    private static final double MIN_SCORE = .50;
    private static final Map<Integer, String> LANDMARKS = Map.ofEntries(
            Map.entry(0, "nose"), Map.entry(11, "leftShoulder"), Map.entry(12, "rightShoulder"),
            Map.entry(23, "leftHip"), Map.entry(24, "rightHip"), Map.entry(25, "leftKnee"), Map.entry(26, "rightKnee"),
            Map.entry(27, "leftAnkle"), Map.entry(28, "rightAnkle"), Map.entry(29, "leftHeel"), Map.entry(30, "rightHeel"),
            Map.entry(31, "leftToe"), Map.entry(32, "rightToe"));
    private final Path model;
    private final ReentrantLock lock = new ReentrantLock();
    private OrtSession session;

    PoseDetector(@Value("${lensmind.vision.pose-model}") String model) {
        this.model = Path.of(model).toAbsolutePath();
    }

    // 外层列表按人物检测框顺序排列。空对象表示该框的关键点未获确认。
    List<Map<String, Point>> detect(BufferedImage frame, List<PersonDetector.Person> people) {
        if (!lock.tryLock()) return null;
        try {
            if (people.isEmpty()) return List.of();
            if (session == null && !Files.isRegularFile(model)) return null;
            var environment = OrtEnvironment.getEnvironment();
            if (session == null) {
                try (var options = new OrtSession.SessionOptions()) {
                    options.setIntraOpNumThreads(2);
                    options.setInterOpNumThreads(1);
                    session = environment.createSession(model.toString(), options);
                }
            }
            var poses = new ArrayList<Map<String, Point>>(people.size());
            for (var person : people) poses.add(estimate(environment, frame, person));
            return poses;
        } catch (OrtException | LinkageError error) {
            return null;
        } finally {
            lock.unlock();
        }
    }

    private Map<String, Point> estimate(OrtEnvironment environment, BufferedImage frame, PersonDetector.Person person) throws OrtException {
        int width = frame.getWidth();
        int height = frame.getHeight();
        double side = Math.max(person.width() * width, person.height() * height) * 1.22;
        double x = (person.x() + person.width() / 2) * width - side / 2;
        double y = (person.y() + person.height() / 2) * height - side / 2;
        var crop = new BufferedImage(SIZE, SIZE, BufferedImage.TYPE_INT_RGB);
        var graphics = crop.createGraphics();
        try {
            graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            double scale = SIZE / side;
            graphics.drawImage(frame, new AffineTransform(scale, 0, 0, scale, -x * scale, -y * scale), null);
        } finally {
            graphics.dispose();
        }
        float[] rgb = new float[SIZE * SIZE * 3];
        int offset = 0;
        for (int pixel : crop.getRGB(0, 0, SIZE, SIZE, null, 0, SIZE)) {
            rgb[offset++] = ((pixel >> 16) & 255) / 255f;
            rgb[offset++] = ((pixel >> 8) & 255) / 255f;
            rgb[offset++] = (pixel & 255) / 255f;
        }
        try (var input = OnnxTensor.createTensor(environment, FloatBuffer.wrap(rgb), new long[]{1, SIZE, SIZE, 3});
             var result = session.run(Map.of("input_1", input), Set.of("Identity", "Identity_1"))) {
            float[][] confidence = (float[][]) result.get("Identity_1").orElseThrow().getValue();
            if (!(confidence[0][0] >= MIN_SCORE)) return Map.of();
            float[] landmarks = ((float[][]) result.get("Identity").orElseThrow().getValue())[0];
            var points = new HashMap<String, Point>();
            for (var landmark : LANDMARKS.entrySet()) {
                int i = landmark.getKey() * 5;
                double score = Math.min(sigmoid(landmarks[i + 3]), sigmoid(landmarks[i + 4]));
                double px = (x + landmarks[i] * side / SIZE) / width;
                double py = (y + landmarks[i + 1] * side / SIZE) / height;
                if (score >= MIN_SCORE && px >= 0 && px <= 1 && py >= 0 && py <= 1) {
                    points.put(landmark.getValue(), new Point(px, py));
                }
            }
            return points;
        }
    }

    private static double sigmoid(float value) {
        return 1 / (1 + Math.exp(-value));
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

    record Point(double x, double y) {}
}
