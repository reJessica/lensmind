package com.example.lensmind.ai;

import java.util.List;

public final class AiContracts {
    private AiContracts() {}
    public enum Intent { STOP, HOME, CAPTURE, MOVE, ZOOM, COMPOSE, GUIDE, CLARIFY }
    public enum Direction { LEFT, RIGHT, UP, DOWN }
    public enum Composition { center, left, right }
    public enum Framing { half, full }

    public record CommandRequest(String text, Composition composition, Framing framing) {}
    public record Command(Intent type, Direction direction, Integer step,
                          Composition composition, Framing framing, Double zoomDelta, String message) {}
    public record Box(double x, double y, double width, double height) {}
    public record Vision(Boolean personDetected, Box personBox, String assessment,
                         String suggestion, String guidance, String stability) {}
    public record FrameAnalysis(String frameId, String capturedAt, int width, int height,
                                Composition composition, Framing framing, Vision analysis) {}
    public record Transcript(String text, String language) {}
    public record SpeechRequest(String text) {}
    public record Result<T>(String requestId, String mode, String source, String model,
                            String promptVersion, T data, List<String> warnings) {}
    public record Audio(byte[] bytes, String contentType, String mode) {}
}
