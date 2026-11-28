"""Run the LeRobot SO-101 calibration with an operator at the arm."""

import argparse
from pathlib import Path
import tempfile

from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig
from serial.tools import list_ports


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list-ports", action="store_true", help="List serial devices without opening them")
    parser.add_argument("--port", help="Local serial port, such as COM9 or /dev/ttyACM0")
    parser.add_argument("--output", type=Path, help="Path to the calibration JSON file")
    args = parser.parse_args()
    if args.list_ports:
        for info in sorted(list_ports.comports()):
            print(f"{info.device}\t{info.description}")
        return
    if not args.port or args.output is None:
        parser.error("--port and --output are required for calibration; use --list-ports to find the local port")
    output = args.output.expanduser().resolve()
    if output.suffix.lower() != ".json":
        parser.error("--output must be a calibration JSON path")

    print(f"SO-101 从臂 {args.port} · 校准记录 {output}")
    print("将底座固定。让机械臂在休息位置得到支撑，扶稳手臂，并清空活动区域。")
    print("校准会卸力并写入舵机校准值。请在旁操作，手指离开夹爪和关节缝隙。")
    if input("确认后输入 CALIBRATE 并回车：").strip() != "CALIBRATE":
        print("已退出校准。")
        return

    output.parent.mkdir(parents=True, exist_ok=True)
    # Save to staging and publish only after the values are read back from the arm.
    with tempfile.TemporaryDirectory(prefix=".so101-calibration-", dir=output.parent) as directory:
        robot = SO101Follower(SO101FollowerConfig(
            port=args.port, id=output.stem, calibration_dir=Path(directory),
            disable_torque_on_disconnect=False,
        ))
        bus = robot.bus
        try:
            # The full robot connect() configures and can re-enable torque.
            try:
                bus.connect()
            except ConnectionError as error:
                raise SystemExit(f"无法打开串口 {args.port}。请核对本机端口、连接和权限，退出占用该串口的控制程序后重试。"
                                 f"\n详细信息：{error.__cause__ or error}") from None
            print("按提示扶稳机械臂，让肩、肘、腕等关节处于各自安全行程的中间。")
            print("开始记录后，逐个缓慢扫过安全可达范围，避开硬限位和线缆。工具会跳过 wrist_roll。")
            robot.calibrate()
            if bus.read_calibration() != robot.calibration:
                raise RuntimeError("舵机读回值与本次校准记录不一致")
            robot.calibration_fpath.replace(output)
            print(f"校准完成，六轴数值已从舵机读回。返回网页点击「核验结果」。文件：{output}")
        finally:
            if bus.is_connected:
                bus.disconnect(disable_torque=False)


if __name__ == "__main__":
    main()
