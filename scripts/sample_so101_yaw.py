"""Read neutral and two manually demonstrated camera yaw positions on a calibrated SO-101."""

import argparse
import hashlib
import json
from pathlib import Path
from statistics import median
from time import sleep

from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig


YAW = "shoulder_pan"
MAX_YAW_SAMPLE_TICKS = 171


def read_pose(arm):
    reads = []
    for _ in range(3):
        readings = arm.bus.sync_read("Present_Position", normalize=False)
        if readings.keys() != arm.calibration.keys():
            raise RuntimeError("未读到完整六轴位置")
        reads.append(readings)
        sleep(0.1)
    pose = {}
    for joint, limits in arm.calibration.items():
        values = [sample[joint] for sample in reads]
        if max(values) - min(values) > 5:
            raise ValueError("机械臂还在移动，请托稳后再记录")
        position = int(median(values))
        if not limits.range_min <= position <= limits.range_max:
            raise ValueError(f"{joint} 超出校准范围")
        pose[joint] = position
    return pose


def collect(arm, prompt, validate=None):
    while True:
        input(prompt)
        try:
            pose = read_pose(arm)
            if validate:
                validate(pose)
            return pose
        except ValueError as error:
            print(f"{error}。请调整姿态后重试。")


def check_yaw(neutral, pose):
    if any(abs(value - neutral[joint]) > 12 for joint, value in pose.items() if joint != YAW):
        raise ValueError("请保持肩部俯仰、肘部、腕部和夹爪姿态，只轻微转动底座")
    delta = pose[YAW] - neutral[YAW]
    if not 8 <= abs(delta) <= MAX_YAW_SAMPLE_TICKS:
        raise ValueError("请相对中立位手动转动约 1 至 15 度")
    return delta


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True)
    parser.add_argument("--calibration", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    calibration = args.calibration.resolve()
    output = args.output.resolve()
    if output == calibration or output.exists():
        parser.error("请为采样记录指定尚不存在的文件，保留已有数据")

    digest = hashlib.sha256(calibration.read_bytes()).hexdigest()
    arm = SO101Follower(SO101FollowerConfig(port=args.port, id=calibration.stem,
        calibration_dir=calibration.parent, disable_torque_on_disconnect=False))
    print("全程扶稳机械臂，根据网页腕部预览判断镜头朝向。左右各自接近 15 度即可，遇到障碍就提前停。")
    print("采样只读舵机。按 Ctrl+C 可退出。")
    try:
        arm.bus.connect()
        if not arm.calibration or arm.bus.read_calibration() != arm.calibration:
            raise RuntimeError("舵机校准与文件不一致")
        if any(arm.bus.sync_read("Torque_Enable", normalize=False).values()):
            raise RuntimeError("舵机有保持力，不能进行手动摆位采样")
        neutral = collect(arm, "1. 扶稳机械臂摆到中立位，按 Enter：")
        left = collect(arm, "2. 保持其余关节，手动让镜头从中立位向左转至示范边界，按 Enter：",
            lambda pose: check_yaw(neutral, pose))
        left_delta = check_yaw(neutral, left)

        def check_right(pose):
            if check_yaw(neutral, pose) * left_delta >= 0:
                raise ValueError("右转姿势需要在中立位的另一侧")

        right = collect(arm, "3. 经过中立位，让镜头向右转至示范边界，按 Enter：", check_right)
    finally:
        if arm.bus.is_connected:
            arm.bus.disconnect(disable_torque=False)

    if hashlib.sha256(calibration.read_bytes()).hexdigest() != digest:
        raise RuntimeError("采样期间校准文件发生变化，请重新采样")
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", encoding="utf-8") as file:
        json.dump({"calibration_sha256": digest, "neutral": neutral, "left": left, "right": right}, file, indent=2)
    print("左右采样完成。请手动回到中立位并继续托稳机械臂。")


if __name__ == "__main__":
    main()
