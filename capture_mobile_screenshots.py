from playwright.sync_api import sync_playwright
import time

BASE = "http://127.0.0.1:19006"
OUT = "/opt/cursor/artifacts/screenshots/mobile"

def shot(page, name, full=False):
    page.screenshot(path=f"{OUT}/{name}", full_page=full)
    print(name)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 390, "height": 844})

    # Welcome
    page.goto(BASE, wait_until="networkidle")
    time.sleep(2)
    shot(page, "01-welcome.png")

    # Student flow
    page.click("text=Student")
    time.sleep(1)
    shot(page, "02-student-login.png")
    page.fill('input[placeholder="e.g. 2211"]', "2211")
    page.click("text=Continue")
    time.sleep(3)
    shot(page, "03-student-home.png")

    page.get_by_role("tab", name="Homework").click()
    time.sleep(1)
    shot(page, "04-student-homework.png")

    page.get_by_role("tab", name="Notices").click()
    time.sleep(1)
    shot(page, "05-student-notices.png")

    page.goto(BASE, wait_until="networkidle")
    time.sleep(1)

    # Parent flow
    page.click("text=Parent")
    time.sleep(1)
    page.fill('input[placeholder="e.g. 2211"]', "2211")
    page.click("text=Continue")
    time.sleep(3)
    shot(page, "06-parent-home.png")

    browser.close()
