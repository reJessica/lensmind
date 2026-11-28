package com.example.lensmind.ai;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.io.*;
import java.util.concurrent.atomic.AtomicBoolean;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class LocalAsrProcessTests {
    private void await(java.util.function.BooleanSupplier done) throws Exception {
        long end = System.nanoTime() + 3_000_000_000L;
        while (!done.getAsBoolean() && System.nanoTime() < end) Thread.sleep(10);
        assertTrue(done.getAsBoolean());
    }

    @Test void disabledDoesNotProbeOrLaunch(@TempDir Path root) {
        var process = new LocalAsrProcess(false, 9001, "", root.toString()) {
            @Override protected boolean healthy() { fail("disabled must not probe"); return false; }
        };
        process.start(); assertTrue(process.failureHint().contains("已关闭")); process.destroy();
    }

    @Test void reusesExternalServiceWithoutOwningIt(@TempDir Path root) throws Exception {
        var process = new LocalAsrProcess(true, 9001, "", root.toString()) {
            @Override protected boolean healthy() { return true; }
            @Override protected Process launch() { fail("must reuse existing service"); return null; }
        };
        process.start(); await(() -> process.failureHint().contains("未响应")); process.destroy();
    }

    @Test void unrelatedPortOwnerDoesNotLaunchOrGetKilled(@TempDir Path root) throws Exception {
        var process = new LocalAsrProcess(true, 9001, "", root.toString()) {
            @Override protected boolean healthy() { return false; }
            @Override protected boolean portAvailable() { return false; }
            @Override protected Process launch() { fail("port is occupied"); return null; }
        };
        process.start(); await(() -> process.failureHint().contains("被其他服务占用")); process.destroy();
    }

    @Test void ownsOnlyLaunchedProcessAndStartsOnce(@TempDir Path root) throws Exception {
        Files.createDirectories(root.resolve("scripts")); Files.createFile(root.resolve("scripts/start_local_asr.py"));
        Process child = mock(Process.class);
        when(child.isAlive()).thenReturn(true);
        when(child.getInputStream()).thenReturn(InputStream.nullInputStream());
        when(child.descendants()).thenAnswer(invocation -> java.util.stream.Stream.empty());
        var launched = new AtomicBoolean();
        var process = new LocalAsrProcess(true, 9001, "", root.toString()) {
            @Override protected boolean healthy() { return launched.get(); }
            @Override protected boolean portAvailable() { return true; }
            @Override protected Process launch() { assertFalse(launched.getAndSet(true)); return child; }
        };
        process.start(); await(launched::get); process.start(); process.destroy();
        verify(child).destroyForcibly();
    }

    @Test void explicitPythonPathAndPortAreSeparateArguments(@TempDir Path root) {
        var process = new LocalAsrProcess(true, 9002, "C:/Python Folder/python.exe", root.toString());
        assertEquals("C:/Python Folder/python.exe", process.command().get(0));
        assertEquals("9002", process.command().get(process.command().size() - 1));
        process.destroy();
    }
}
