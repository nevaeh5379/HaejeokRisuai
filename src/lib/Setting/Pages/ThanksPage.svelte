<script lang="ts">
    import { language } from "src/lang";
    import { openURL } from "src/ts/globalApi.svelte";


    interface supporters{
        I: string[],
        II: string[],
        III: string[],
        IV: string[],
        V: string[],
    }

    interface supporterL{
        amount: number,
        name: string,
    }

    async function loadSupporters() {

        const supp = await fetch("https://sv.risuai.xyz/patreon/list")

        const list = await supp.json() as supporterL[]
        const thanks: supporters = {
            I: [],
            II: [],
            III: [],
            IV: [],
            V: [],
        }
        for (const v of list) {
            if (v.amount < 5) thanks.I.push(v.name)
            else if (v.amount < 10) thanks.II.push(v.name)
            else if (v.amount < 20) thanks.III.push(v.name)
            else if (v.amount < 50) thanks.IV.push(v.name)
            else thanks.V.push(v.name)
        }
        return thanks
    }
</script>

<h2 class="text-2xl font-bold mt-2">{language.supporterThanks}</h2>
<span class="mb-2 text-textcolor2">{language.supporterThanksDesc}</span>

<!-- Patreon Button -->
<div class="flex items-center justify-center rounded-md flex-wrap gap-2">
    <button class="h-12 w-44" onclick={() => {
        openURL("https://www.patreon.com/RisuAI")
    }}>
        <img src="https://c5.patreon.com/external/logo/become_a_patron_button.png" alt="patreon button" class="w-full h-full"/>
    </button>
    <button class="h-12 w-44 bg-slate-700 font-bold text-sm" onclick={() => {
        openURL("https://sv.risuai.xyz/patreon")
    }}>
        ADD YOUR NAME
    </button>
</div>

<!-- Supporters -->

{#await loadSupporters()}
    <span>Loading...</span>

{:then supporter}
    <h3 class="text-xl font-bold mt-4">Supporter V</h3>
    <div class="flex w-full max-w-full flex-wrap gap-2"> 
        {#each supporter.V as support}
            <div class="flex flex-col items-center justify-center border-selected border rounded-sm">
                <div class="flex justify-center items-center py-4 px-8">
                    <span class="font-black prism-font prism-font-gold text-3xl">{support}</span>
                </div>
            </div>
        {/each}
    </div>
    <h3 class="text-xl font-bold mt-4">Supporter IV</h3>
    <div class="flex w-full max-w-3xl flex-wrap gap-2"> 
        {#each supporter.IV as support}
            <div class="flex flex-col items-center justify-center border-selected border rounded-sm">
                <div class="flex justify-center items-center py-4 px-8">
                    <span class="font-black prism-font prism-font-silver text-2xl">{support}</span>
                </div>
            </div>
        {/each}
    </div>
    <h3 class="text-xl font-bold mt-4">Supporter III</h3>
    <div class="flex w-full max-w-3xl flex-wrap gap-2"> 
        {#each supporter.III as support}
            <!-- make a card -->
            <div class="flex flex-col items-center justify-center border-selected border rounded-sm">
                <div class="w-32 flex justify-center items-center py-3 px-6">
                    <span class="font-black prism-font prism-font-silver text-xl">{support}</span>
                </div>
            </div>
        {/each}
    </div>
    <h3 class="text-xl font-bold mt-4">Supporter II</h3>
    <div class="flex w-full max-w-3xl flex-wrap gap-2"> 
        {#each supporter.II as support}
            <!-- make a card -->
            <div class="flex flex-col items-center justify-center border-selected border rounded-sm">
                <div class="w-32 flex justify-center items-center p-1">
                    <span class="font-bold prism-font prism-font-copper text-lg">{support}</span>
                </div>
            </div>
        {/each}
    </div>
    <h3 class="text-xl font-bold mt-4">Supporter I</h3>
    <div class="flex w-full max-w-3xl flex-wrap gap-2"> 
        {#each supporter.I as support}
            <!-- make a card -->
            <div class="flex flex-col items-center justify-center border-selected border rounded-sm">
                <div class="w-32 flex justify-center items-center p-1">
                    <span class="font-bold prism-font prism-font-copper">{support}</span>
                </div>
            </div>
        {/each}
    </div>
{/await}


<style>

    .prism-font-silver{
        background: linear-gradient(to right, #777, #fff ,#777, #fff, #777);
    }
    .prism-font-gold{
        background: linear-gradient(to right, #D4AF32, #fff ,#D4AF32, #fff, #D4AF32);
    }
    .prism-font-copper{
        background: linear-gradient(to right, #B87333, #fff ,#B87333, #fff, #B87333);
    }

    .prism-font{
		text-align: center;
		color: transparent;
        background-size: 150px 100%;
		background-clip: text;
		animation-name: shimmer;
		animation-duration: 2s;
		animation-iteration-count: infinite;
		background-repeat: no-repeat;
		background-position: 0 0;
		background-color: #222;
    }
    @keyframes shimmer {
		0% {
			background-position: top left;
		}
		50% {
			background-position: top right;
		}
        0% {
			background-position: top left;
		}
    }
</style>