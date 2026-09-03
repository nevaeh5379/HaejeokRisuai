import { expect, test } from '@playwright/test';

test('test', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.goto('http://127.0.0.1:5174/');
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await page.getByRole('button', { name: 'Recommended Quick AI Setup' }).click();
  await page.getByRole('textbox', { name: 'Enter your nickname (e.g.' }).click();
  await page.getByRole('textbox', { name: 'Enter your nickname (e.g.' }).fill('iris');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: '나중에 설정하기 설정 화면에서 직접 구성' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: '128k' }).click();
  await page.getByRole('button', { name: 'English (Original)' }).click();
  await page.getByRole('spinbutton', { name: '1000' }).click();
  await page.getByRole('spinbutton', { name: '1000' }).fill('30000');
  await page.getByRole('button', { name: 'Complete Setup' }).click();
  await page.getByRole('button', { name: 'Launch Haejeok RisuAI' }).click();
  await expect(page.getByRole('button', { name: 'Launch Haejeok RisuAI' })).toHaveCount(0);

  const addCharacterButton = page.locator("button:has(svg path[d*='M12 6v6m0 0v6m0-6h6m-6 0H6'])");
  await addCharacterButton.click();
  await page.getByRole('button', { name: 'Create from Scratch' }).click();
  await page.getByRole('button', { name: 'Character' }).click();
  await page.getByRole('textbox').nth(1).click();
  await page.getByRole('textbox').nth(1).fill('hello world!\nmy name! ah iris!!');
  await page.getByRole('textbox', { name: 'Character Name' }).click();
  await page.getByRole('textbox', { name: 'Character Name' }).fill('iris');

  await page.locator('button:has(svg.lucide-share-2)').click();
  await page.getByRole('button', { name: 'Export Character' }).click();

  await page.getByRole('button', { name: 'Character Card V3', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadPromise;

  const savedPath = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(savedPath);
  await page.getByRole('button', { name: 'OK' }).click();
  await addCharacterButton.click();
  await page.getByRole('button', { name: 'Import Character' }).click();

  const fileChooserPromise = page.waitForEvent('filechooser');
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles(savedPath);
});